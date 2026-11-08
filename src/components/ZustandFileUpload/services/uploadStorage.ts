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
  /** 中断且既无运行时 fileRef、也无分片缓存的条数，需用户重新选择后上传 */
  missingFileRefCount: number;
}

/**
 * 挂载恢复所需的分片缓存查询（方案 A）。
 * 由调用方注入，避免本模块直接依赖 IndexedDB；测试可传假实现。
 */
export interface UploadRecoveryChunkCache {
  /** 该实例下“分片缓存已完整落盘”的文件 id 集合（一次游标遍历） */
  listReadyFileIds: () => Promise<Set<string>>;
}

const INTERRUPTED_RECOVERY_MESSAGE =
  "检测到页面刷新导致上传中断，本地续传缓存缺失，请重新选择文件";
const STALE_QUEUE_MESSAGE =
  "页面已刷新，本地续传缓存缺失，请重新选择文件后上传";

/**
 * 中断任务能否零点击续传：
 * - 会话内仍持有 fileRef → 可直接重建文件数据；
 * - 刷新后 fileRef 丢失 → 依赖分片缓存（方案 A）重建。
 */
const canResumeWithoutReselect = (
  file: UploadFile,
  readyCachedFileIds: Set<string>
): boolean => Boolean(file.fileRef) || readyCachedFileIds.has(file.id);

export const recoverInterruptedUploadFiles = async (
  storage: LocalForage,
  chunkCache?: UploadRecoveryChunkCache
): Promise<UploadRecoverySummary> => {
  const files = await listUploadFiles(storage);
  const readyCachedFileIds = chunkCache
    ? await chunkCache.listReadyFileIds().catch(() => new Set<string>())
    : new Set<string>();
  const writes: Array<{ id: string; file: UploadFile }> = [];
  let recoveredCount = 0;
  let missingFileRefCount = 0;
  let totalInterrupted = 0;

  for (const file of files) {
    if (!interruptedUploadStatuses.has(file.status)) {
      continue;
    }

    totalInterrupted += 1;

    // 运行时 fileRef 刷新即丢失；分片缓存就绪时同样可恢复为待上传。
    if (canResumeWithoutReselect(file, readyCachedFileIds)) {
      writes.push({
        id: file.id,
        file: {
          ...file,
          status: UploadStatus.QUEUED,
          errorMessage: undefined,
          awaitingReselect: false,
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
        awaitingReselect: true,
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
 *  阶段 1：中断任务按「fileRef 或分片缓存是否可用」→ QUEUED / ERROR；
 *  阶段 2：治理历史 QUEUED / QUEUED_FOR_UPLOAD 行——缓存就绪的保留 QUEUED
 *          参与自动续传，缺失的降级为 awaitingReselect 的 ERROR。
 * 最后只把「确实变化」的记录并发写一次，并返回最终快照供 store 直接采用。
 */
export const recoverUploadQueueOnMount = async (
  storage: LocalForage,
  chunkCache?: UploadRecoveryChunkCache
): Promise<UploadRecoverySnapshot> => {
  // 唯一一次 iterate；listUploadFiles 已按 createdAt 排序。
  const files = await listUploadFiles(storage);
  // 分片缓存一次性取就绪集合（无 IndexedDB 时注入方会返回空集）。
  const readyCachedFileIds = chunkCache
    ? await chunkCache.listReadyFileIds().catch(() => new Set<string>())
    : new Set<string>();

  let totalInterrupted = 0;
  let recoveredCount = 0;
  let missingFileRefCount = 0;
  const handledByStageOne = new Set<string>();

  const afterRecovery = files.map((file): UploadFile => {
    if (!interruptedUploadStatuses.has(file.status)) {
      return file;
    }

    handledByStageOne.add(file.id);
    totalInterrupted += 1;
    if (canResumeWithoutReselect(file, readyCachedFileIds)) {
      recoveredCount += 1;
      return {
        ...file,
        status: UploadStatus.QUEUED,
        errorMessage: undefined,
        awaitingReselect: false,
      };
    }

    missingFileRefCount += 1;
    return {
      ...file,
      status: UploadStatus.ERROR,
      progress: 0,
      errorMessage: INTERRUPTED_RECOVERY_MESSAGE,
      awaitingReselect: true,
    };
  });

  const finalFiles = afterRecovery.map((file): UploadFile => {
    if (
      file.status !== UploadStatus.QUEUED &&
      file.status !== UploadStatus.QUEUED_FOR_UPLOAD
    ) {
      return file;
    }
    // 阶段 1 已把可续传的中断任务恢复为 QUEUED，跳过，避免二次计数/降级。
    if (handledByStageOne.has(file.id)) {
      return file;
    }
    // 刷新前就在队列中的记录：缓存就绪同样零点击续传；否则仍需重选。
    if (canResumeWithoutReselect(file, readyCachedFileIds)) {
      totalInterrupted += 1;
      recoveredCount += 1;
      // 保持 QUEUED，交由 autoUpload 再次拉起；无需改写其它字段。
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
