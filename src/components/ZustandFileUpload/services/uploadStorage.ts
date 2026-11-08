import { UploadStatus, type UploadFile } from "../types/upload";
import type { FileRegistry } from "./fileRegistry";
import { migrateUploadFile } from "./uploadSchema";

/**
 * P2-4：读取即迁移（纯内存，不回写）。
 * 旧记录缺字段 / 状态是历史字符串时补齐并映射，结构性损坏（缺 id、fileName、
 * createdAt）直接丢弃。回写交给后续真实业务写入（写入时统一盖 schemaVersion），
 * 避免"读操作产生写放大"。
 */
export const listUploadFiles = async (
  storage: LocalForage
): Promise<UploadFile[]> => {
  const files: UploadFile[] = [];

  await storage.iterate<unknown, void>((value) => {
    const result = migrateUploadFile(value);
    if (result) {
      files.push(result.file);
    }
  });

  files.sort((a, b) => a.createdAt - b.createdAt);
  return files;
};

/** 单条读取（同样过迁移层），供清理策略等按 id 读取的场景使用。 */
export const readUploadFile = async (
  storage: LocalForage,
  id: string
): Promise<UploadFile | null> => {
  const raw = await storage.getItem<unknown>(id);
  const result = migrateUploadFile(raw);
  return result ? result.file : null;
};

export const removeUploadFilesByIds = async (
  ids: string[],
  storage: LocalForage,
  fileRegistry: FileRegistry
): Promise<void> => {
  if (ids.length === 0) {
    return;
  }

  await Promise.all(
    ids.map((id) => {
      // 同步释放主线程文件引用，避免 File 句柄长期驻留
      fileRegistry.releaseFileRef(id);
      return storage.removeItem(id);
    })
  );
};

const interruptedUploadStatuses = new Set<UploadStatus>([
  UploadStatus.PREPARING_UPLOAD,
  UploadStatus.UPLOADING,
  UploadStatus.QUEUED_FOR_UPLOAD,
]);

export const isUploadableStatus = (status: UploadStatus) =>
  // PAUSED 需显式「继续」才续传（T3.3），不纳入自动可上传集合，避免与暂停中的
  // Worker 挂起任务双跑；ERROR/QUEUED 等仍可由 uploadAll/重试自动拾起。
  status === UploadStatus.QUEUED ||
  status === UploadStatus.QUEUED_FOR_UPLOAD ||
  status === UploadStatus.PREPARING_UPLOAD ||
  status === UploadStatus.UPLOADING ||
  status === UploadStatus.ERROR;

export interface UploadRecoverySummary {
  totalInterrupted: number;
  recoveredCount: number;
  /** 中断但因刷新丢失运行时文件引用（fileRef）的条数，需用户重新选择后上传 */
  missingFileRefCount: number;
}

const INTERRUPTED_RECOVERY_MESSAGE =
  "检测到页面刷新导致上传中断，文件缓存缺失，请重新选择文件";
const STALE_QUEUE_MESSAGE = "页面已刷新，请重新选择文件后上传";

export const recoverInterruptedUploadFiles = async (
  storage: LocalForage
): Promise<UploadRecoverySummary> => {
  const files = await listUploadFiles(storage);
  const writes: Array<{ id: string; file: UploadFile }> = [];
  let recoveredCount = 0;
  let missingFileRefCount = 0;
  let totalInterrupted = 0;

  for (const file of files) {
    if (!interruptedUploadStatuses.has(file.status)) {
      continue;
    }

    totalInterrupted += 1;

    // T3.1：运行时文件引用（fileRef）只存在于当前会话内存，刷新即丢失；
    // 仍持有引用的中断任务可恢复为待上传，否则标记需重新选择。
    if (file.fileRef) {
      writes.push({
        id: file.id,
        file: {
          ...file,
          status: UploadStatus.QUEUED,
          errorMessage: undefined,
        },
      });
      recoveredCount += 1;
      continue;
    }

    writes.push({
      id: file.id,
      file: {
        ...file,
        status: UploadStatus.ERROR,
        progress: 0,
        errorMessage: INTERRUPTED_RECOVERY_MESSAGE,
      },
    });
    missingFileRefCount += 1;
  }

  // VU-43：彼此独立的 IDB 写入并发执行，不再逐个串行 await。
  await Promise.all(writes.map(({ id, file }) => storage.setItem(id, file)));

  return {
    totalInterrupted,
    recoveredCount,
    missingFileRefCount,
  };
};

export interface UploadRecoverySnapshot {
  /** 应用全部恢复 / 治理写入后的最终有序快照，可直接喂给 refreshFiles(snapshot)。 */
  files: UploadFile[];
  summary: UploadRecoverySummary;
  /** 本次实际落库的条数（同一条记录只写最终态一次）。 */
  writeCount: number;
}

/**
 * VU-39：把「挂载恢复」压成一次 IDB 全量读。
 *
 * 旧链路为 `recoverInterruptedUploadFiles`（iterate + 逐条写）→ `loadAllUploadFiles`
 * （第二次 iterate）→ 逐条写 → `refreshFiles`（第三次 iterate），共 3 次全表遍历。
 * 这里保留完全相同的两阶段语义，但都在内存里完成：
 *  阶段 1：中断任务按 fileRef 有无 → QUEUED / ERROR；
 *  阶段 2：以阶段 1 结果为输入治理历史 QUEUED 行（刷新后无运行时 File 引用，
 *          无法自动上传）→ awaitingReselect 的 ERROR。
 * 最后只把「确实变化」的记录并发写一次，并返回最终快照供 store 直接采用。
 */
export const recoverUploadQueueOnMount = async (
  storage: LocalForage
): Promise<UploadRecoverySnapshot> => {
  // 唯一一次 iterate；listUploadFiles 已按 createdAt 排序。
  const files = await listUploadFiles(storage);

  let totalInterrupted = 0;
  let recoveredCount = 0;
  let missingFileRefCount = 0;

  const afterRecovery = files.map((file): UploadFile => {
    if (!interruptedUploadStatuses.has(file.status)) {
      return file;
    }

    totalInterrupted += 1;
    if (file.fileRef) {
      recoveredCount += 1;
      return {
        ...file,
        status: UploadStatus.QUEUED,
        errorMessage: undefined,
      };
    }

    missingFileRefCount += 1;
    return {
      ...file,
      status: UploadStatus.ERROR,
      progress: 0,
      errorMessage: INTERRUPTED_RECOVERY_MESSAGE,
    };
  });

  const finalFiles = afterRecovery.map((file): UploadFile => {
    if (
      file.status !== UploadStatus.QUEUED &&
      file.status !== UploadStatus.QUEUED_FOR_UPLOAD
    ) {
      return file;
    }
    return {
      ...file,
      status: UploadStatus.ERROR,
      progress: 0,
      errorMessage: STALE_QUEUE_MESSAGE,
      awaitingReselect: true,
    };
  });

  const writes: Array<{ id: string; file: UploadFile }> = [];
  for (let i = 0; i < files.length; i += 1) {
    const original = files[i]!;
    const finalFile = finalFiles[i]!;
    if (original !== finalFile && !shallowEqualUploadFile(original, finalFile)) {
      writes.push({ id: finalFile.id, file: finalFile });
    }
  }

  await Promise.all(writes.map(({ id, file }) => storage.setItem(id, file)));

  return {
    files: finalFiles,
    summary: { totalInterrupted, recoveredCount, missingFileRefCount },
    writeCount: writes.length,
  };
};

/** 只比恢复 / 治理会改动的字段，避免对整对象做深比较。 */
const shallowEqualUploadFile = (a: UploadFile, b: UploadFile): boolean =>
  a.status === b.status &&
  a.progress === b.progress &&
  a.errorMessage === b.errorMessage &&
  a.awaitingReselect === b.awaitingReselect;
