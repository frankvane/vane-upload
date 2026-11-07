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

export const recoverInterruptedUploadFiles = async (
  storage: LocalForage
): Promise<UploadRecoverySummary> => {
  const files = await listUploadFiles(storage);
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
      const nextFile: UploadFile = {
        ...file,
        status: UploadStatus.QUEUED,
        errorMessage: undefined,
      };
      await storage.setItem(file.id, nextFile);
      recoveredCount += 1;
      continue;
    }

    const brokenFile: UploadFile = {
      ...file,
      status: UploadStatus.ERROR,
      progress: 0,
      errorMessage: "检测到页面刷新导致上传中断，文件缓存缺失，请重新选择文件",
    };
    await storage.setItem(file.id, brokenFile);
    missingFileRefCount += 1;
  }

  return {
    totalInterrupted,
    recoveredCount,
    missingFileRefCount,
  };
};
