import type { UploadAuthConfig } from "../utils/auth";

export type { UploadAuthConfig };

export enum UploadStatus {
  // Waiting in queue.
  QUEUED = "queued",
  // Queued and waiting for actual upload.
  QUEUED_FOR_UPLOAD = "queued-for-upload",
  // Preparing upload request and chunks.
  PREPARING_UPLOAD = "preparing-upload",
  // Uploading chunks.
  UPLOADING = "uploading",
  // Paused by user or runtime condition (T3.3：分片边界安全暂停，可继续续传).
  PAUSED = "paused",
  // Upload completed.
  DONE = "done",
  // Instant upload (already exists on server).
  INSTANT = "instant",
  // Upload failed.
  ERROR = "error",
}

export interface UploadFile {
  id: string; // Unique id
  fileName: string; // File name
  fileSize: number; // File size
  fileType: string; // MIME type
  lastModified: number; // Last modified timestamp
  status: UploadStatus; // Upload status
  progress: number; // Progress [0-100]
  /** P2-4：落盘 schema 版本；读取时按它决定是否需要迁移 */
  schemaVersion?: number;
  hash?: string; // File hash
  chunkSize?: number; // Chunk size
  chunkCount?: number; // Total chunk count
  uploadedChunks?: number; // Uploaded chunk count
  pausedChunks?: number[]; // Uploaded chunk indexes while paused
  errorMessage?: string; // Error message
  createdAt: number; // Created timestamp
  order: number; // Queue order
  /**
   * 运行时文件引用（T3.1 起替代原 buffer 字段）：
   * 不持久化进 IndexedDB，仅当前会话内存持有；页面刷新即丢失，
   * 续传需用户重新选择同一文件（服务端分片检查决定跳过范围）。
   */
  fileRef?: File;
  /** 本条记录使用的哈希模式（影响队列 id / 服务端分片键，会话间不宜变更） */
  hashMode?: UploadHashMode;
  /** 刷新后等待用户重新选择文件：为 true 时 uploadAll 跳过并提示 */
  awaitingReselect?: boolean;
  /**
   * T3.4：UI 派生即时字段（不持久化）。当前瞬时速率（字节/秒）与预计剩余时间
   * （秒），由 store 的 speedMap/etaMap 经 dataSource 注入表格行，供进度列展示。
   */
  speed?: number;
  /** T3.4：UI 派生即时字段（不持久化）。预计剩余时间（秒） */
  eta?: number;
}

export interface ProcessingStats {
  total: number;
  processed: number;
  success: number;
  failed: number;
  oversized: number;
  startTime: number;
  endTime?: number;
  totalTime?: number;
}

export type UploadUIMode = "full" | "simple";
export type UploadSettingsSource = "localStorage" | "props";
/**
 * 文件哈希模式（T3.1）：
 * - "full"（默认）：全量流式哈希——按 1MB 分块顺序读入 Worker 增量计算，
 *   内存驻留与文件大小无关；哈希值与文件内容一一对应，服务端合并时强校验。
 * - "sample"：采样哈希——首 4MB + 中间 3 个 4MB 采样点 + 尾 4MB + 文件大小，
 *   大文件可跳过绝大部分读取；代价是存在极低概率的采样碰撞（同大小且采样
 *   区内容一致的不同文件会被视为同一文件），服务端合并时退化为
 *   「大小 + 逐分片 md5」校验（分片级仍全覆盖，不含糊）。
 */
export type UploadHashMode = "sample" | "full";

// Upload component props.
export interface ZustandFileUploadProps extends UploadAuthConfig {
  // API config
  baseURL?: string;
  uploadApi?: string;
  checkApi?: string;
  mergeApi?: string;

  // Network/upload tuning
  chunkSize?: number;
  fileConcurrency?: number;
  chunkConcurrency?: number;
  maxRetries?: number;
  /**
   * 文件哈希模式（T3.1）。默认 "full"（全量流式哈希，内存与文件大小无关）；
   * "sample" 为采样哈希，适合超大文件、可容忍极低概率采样碰撞的场景。
   */
  hashMode?: UploadHashMode;

  // File constraints
  maxFileSize?: number; // Per-file limit in bytes
  allowedFileTypes?: string[]; // Allowed MIME types/extensions
  maxFiles?: number; // Max file count

  // UI behavior
  autoUpload?: boolean;
  autoCleanup?: boolean;
  cleanupDelay?: number;
  networkDisplayMode?: "tooltip" | "direct";
  uiMode?: UploadUIMode;
  settingsSource?: UploadSettingsSource;
  /** 调试日志开关：默认 false。开启后 Worker 输出分片级日志（200ms 节流） */
  debug?: boolean;

  // Callbacks
  onUploadStart?: (files: UploadFile[]) => void;
  /**
   * 上传进度回调（兼容旧签名：仅百分比）。
   * @deprecated 自 v2.0.0 起建议使用 {@link onUploadProgressDetail} 获取字节级速率/剩余时间；
   * 旧签名仍保留，回调参数为 `detail.progress`（0-100）。
   */
  onUploadProgress?: (file: UploadFile, progress: number) => void;
  /** 上传进度回调（v2.0.0 新增）：携带字节级进度、速率与预计剩余时间 */
  onUploadProgressDetail?: (file: UploadFile, detail: UploadProgressDetail) => void;
  onUploadComplete?: (file: UploadFile, success: boolean) => void;
  onUploadError?: (file: UploadFile, error: string) => void;
  onBatchComplete?: (results: {
    success: number;
    failed: number;
    total: number;
  }) => void;

  // Custom handlers
  customFileValidator?: (file: File) => { valid: boolean; message?: string };
  customUploadHandler?: (
    file: UploadFile,
    config: UploadConfig
  ) => Promise<boolean>;

  /**
   * 实例标识（T3.2 单例治理）。用于隔离同页多个 <FileUpload> 的 IndexedDB
   * 存储（storeName 后缀）。不传时回落到默认 storeName，保持单实例刷新续传行为。
   * 多实例场景传入不同 id 即可互不串数据。
   */
  instanceId?: string;

  /**
   * 上传表格可见列控制。传入列 key 数组，仅显示并**按数组顺序**排列这些列；
   * 缺省（不传）显示全部内置列（编号/文件名/大小/分片数/状态/进度/操作）。
   * 注意：隐藏「操作」列后，表格内将不再提供暂停/继续/重试/删除按钮。
   */
  visibleColumns?: UploadColumnKey[];
}

// 上传表格列 key（供 {@link ZustandFileUploadProps.visibleColumns} 使用）
export type UploadColumnKey =
  | "index"
  | "fileName"
  | "fileSize"
  | "chunkCount"
  | "status"
  | "progress"
  | "action";

// Internal upload config.
export interface UploadConfig {
  baseURL: string;
  uploadApi: string;
  checkApi: string;
  mergeApi: string;
  chunkSize: number;
  fileConcurrency: number;
  chunkConcurrency: number;
  maxRetries: number;
  /** 文件哈希模式：full=全量流式（默认），sample=采样。见 UploadHashMode 说明 */
  hashMode: UploadHashMode;
  maxFileSize: number;
  allowedFileTypes: string[];
  maxFiles: number;
  /** 是否以 credentials:'include' 发送请求（携带 Cookie）。默认 false。见 utils/auth.ts 说明。 */
  withCredentials?: boolean;
  /** 调试日志开关（Worker 内分片级日志，200ms 节流）。默认 false。 */
  debug?: boolean;
}

export const statusMap: Record<string, { text: string; color: string }> = {
  queued: { text: "排队中", color: "default" },
  "queued-for-upload": { text: "待上传", color: "default" },
  "preparing-upload": { text: "准备上传", color: "processing" },
  uploading: { text: "上传中", color: "processing" },
  paused: { text: "已暂停", color: "orange" },
  done: { text: "已完成", color: "green" },
  instant: { text: "秒传成功", color: "cyan" },
  error: { text: "上传失败", color: "red" },
};

/** 字节级上传进度详情（T3.4）：供 onUploadProgressDetail 回调与 UI 速率展示 */
export interface UploadProgressDetail {
  /** 整体百分比 [0-100] */
  progress: number;
  /** 已上传字节数 */
  uploadedBytes: number;
  /** 文件总字节数 */
  totalBytes: number;
  /** 瞬时速率（字节/秒），已做 0 除与极值保护 */
  speed: number;
  /** 预计剩余时间（秒），无法估算时为 0 */
  eta: number;
}

export type AlignItem = "left" | "center" | "right";

export interface BatchInfo {
  current: number; // Processed count
  total: number; // Total count
  queued: number; // Queued count
  active: number; // Active count
  completed: number; // Completed count
  failed: number; // Failed count
  retried: number; // Retried count
  countdown?: number; // Cleanup countdown in seconds
}

export interface ProcessProgress {
  processed: number;
  total: number;
  success: number;
  failed: number;
  oversized: number;
}
