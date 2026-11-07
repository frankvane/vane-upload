import { UploadStatus, type UploadFile } from "../types/upload";

/**
 * P2-4：上传元数据 schema 版本与迁移层。
 *
 * 此前 `uploadStorageInstance` 只指定 name/storeName，没有版本号、升级钩子，
 * 读到旧记录后直接 `...file` 展开参与状态恢复——字段缺失、状态枚举变化
 * （历史字符串如 `success` / `failed`）都会让 UI 进入未定义状态。
 *
 * 约定：
 * - 所有写入都带 `schemaVersion`（由 storage 包装器统一盖章）；
 * - 所有读取都过 `migrateUploadFile`，补齐默认值并把历史状态映射到当前枚举。
 */
export const UPLOAD_SCHEMA_VERSION = 2;

const VALID_STATUS = new Set<string>(Object.values(UploadStatus));

/** 历史状态字符串 → 当前枚举（旧版本落盘数据） */
const LEGACY_STATUS_MAP: Record<string, UploadStatus> = {
  pending: UploadStatus.QUEUED,
  waiting: UploadStatus.QUEUED,
  queued: UploadStatus.QUEUED,
  uploading: UploadStatus.UPLOADING,
  uploading_chunk: UploadStatus.UPLOADING,
  preparing: UploadStatus.PREPARING_UPLOAD,
  success: UploadStatus.DONE,
  complete: UploadStatus.DONE,
  completed: UploadStatus.DONE,
  done: UploadStatus.DONE,
  fail: UploadStatus.ERROR,
  failed: UploadStatus.ERROR,
  error: UploadStatus.ERROR,
  canceled: UploadStatus.PAUSED,
  cancelled: UploadStatus.PAUSED,
  stopped: UploadStatus.PAUSED,
};

const toFiniteNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const clampProgress = (value: unknown): number => {
  const progress = toFiniteNumber(value, 0);
  return Math.min(100, Math.max(0, progress));
};

export interface UploadFileMigration {
  file: UploadFile;
  /** true 表示该记录来自旧 schema，调用方应把升级后的结果写回 */
  migrated: boolean;
}

/**
 * 把任意落盘数据规整为当前 schema 的 `UploadFile`。
 * 结构性损坏（缺 id / fileName / createdAt）返回 null，由调用方丢弃。
 */
export const migrateUploadFile = (raw: unknown): UploadFileMigration | null => {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    return null;
  }
  if (typeof record.fileName !== "string") {
    return null;
  }
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) {
    return null;
  }

  const rawStatus = typeof record.status === "string" ? record.status : "";
  const status = VALID_STATUS.has(rawStatus)
    ? (rawStatus as UploadStatus)
    : LEGACY_STATUS_MAP[rawStatus.toLowerCase()] ?? UploadStatus.PAUSED;

  const createdAt = record.createdAt;

  const file: UploadFile = {
    ...(record as unknown as UploadFile),
    id: record.id,
    fileName: record.fileName,
    fileSize: toFiniteNumber(record.fileSize, 0),
    fileType: typeof record.fileType === "string" ? record.fileType : "",
    lastModified: toFiniteNumber(record.lastModified, createdAt),
    status,
    progress: clampProgress(record.progress),
    createdAt,
    order: toFiniteNumber(record.order, createdAt),
    schemaVersion: UPLOAD_SCHEMA_VERSION,
  };

  return { file, migrated: record.schemaVersion !== UPLOAD_SCHEMA_VERSION };
};

/** 写入前统一盖章（由 `createUploadStorage` 的 setItem 包装调用）。 */
export const stampUploadSchema = <T>(value: T): T => {
  if (!value || typeof value !== "object") {
    return value;
  }
  return {
    ...(value as Record<string, unknown>),
    schemaVersion: UPLOAD_SCHEMA_VERSION,
  } as T;
};
