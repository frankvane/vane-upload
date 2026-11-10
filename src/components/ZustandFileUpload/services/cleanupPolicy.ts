import { type BatchInfo, UploadFile, UploadStatus, type UploadStorage } from "../types/upload";
import type { FileRegistry } from "./fileRegistry";
import { listUploadFiles } from "./uploadStorage";
import { clearFileChunkCache } from "./chunkCache";

interface CleanupPolicyOptions {
  getFiles: () => UploadFile[];
  setFiles: (files: UploadFile[]) => void;
  /** 传入已知快照时直接采用，避免再读一遍 IndexedDB（VU-50）。 */
  refreshFiles: (knownFiles?: UploadFile[]) => Promise<void>;
  setBatchInfo: (
    updater:
      | BatchInfo
      | null
      | ((prev: BatchInfo | null) => BatchInfo | null)
  ) => void;
  clearBatchInfo: () => void;
  getCleanupDelay: () => number;
  /** 该实例的 IndexedDB 存储（T3.2：替换全局 localforage 默认实例） */
  storage: UploadStorage;
  /** 该实例的 File 引用注册表（T3.2：替换模块级单例） */
  fileRegistry: FileRegistry;
  /** 实例 id：用于按实例/文件清理分片缓存（方案 A）。缺省 "default" */
  instanceId?: string;
}

const canCleanup = (status: UploadStatus) =>
  status === UploadStatus.DONE || status === UploadStatus.INSTANT;

/**
 * P2-2：倒计时期间文件可能被重新上传 / 恢复上传。
 * 这些状态说明文件「又活过来了」，绝不能在清理时从 UI 或 DB 移除，
 * 同时必须移出待清理集合，避免下一轮倒计时再误删。
 */
const isUploadInFlight = (status: UploadStatus) =>
  status === UploadStatus.QUEUED ||
  status === UploadStatus.QUEUED_FOR_UPLOAD ||
  status === UploadStatus.PREPARING_UPLOAD ||
  status === UploadStatus.UPLOADING ||
  status === UploadStatus.PAUSED;

export class UploadCleanupPolicy {
  private readonly completedFileIds = new Set<string>();
  private countdownTimer: number | null = null;
  // VU-50：延迟清空批次信息的定时器必须可取消，否则卸载后仍会写 store。
  private clearBatchInfoTimer: number | null = null;
  private countdownValue = 0;

  constructor(private readonly options: CleanupPolicyOptions) {}

  dispose() {
    if (this.countdownTimer !== null) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    if (this.clearBatchInfoTimer !== null) {
      clearTimeout(this.clearBatchInfoTimer);
      this.clearBatchInfoTimer = null;
    }
  }

  pendingCount() {
    return this.completedFileIds.size;
  }

  private syncCompletedFile(file: UploadFile) {
    if (canCleanup(file.status)) {
      this.completedFileIds.add(file.id);
      return;
    }

    this.completedFileIds.delete(file.id);
  }

  async addCompletedFile(fileId: string) {
    const file = await this.options.storage.getItem<UploadFile>(fileId);
    if (!file) {
      return;
    }

    this.syncCompletedFile(file);
  }

  scheduleCleanup(seconds = this.options.getCleanupDelay()) {
    this.startCountdown(seconds);
  }

  async cleanupUploadedFiles() {
    const files = await listUploadFiles(this.options.storage);
    let markedCount = 0;

    for (const file of files) {
      if (!canCleanup(file.status)) {
        continue;
      }

      this.syncCompletedFile(file);
      markedCount += 1;
    }

    if (markedCount === 0) {
      return;
    }

    const delay = this.options.getCleanupDelay();
    this.options.setBatchInfo({
      current: markedCount,
      total: markedCount,
      queued: 0,
      active: 0,
      completed: markedCount,
      failed: 0,
      retried: 0,
      countdown: delay,
    });

    this.startCountdown(delay);
  }

  async cleanupCompletedFilesFromIndexedDB() {
    // VU-43 / VU-50：一次 iterate 拿全量快照，替代「每个 id 各读一次」；
    // 删除并发执行，并把过滤后的快照直接交给 refreshFiles，避免第二次全表读。
    const snapshot = await listUploadFiles(this.options.storage);
    const byId = new Map(snapshot.map((file) => [file.id, file]));
    // P2-2：倒计时期间用户可能重新发起上传，store 内存态会先于 / 同步于
    // IDB 变化。用零 IO 的内存态复核一次，避免快照滞后导致误删在途文件。
    const liveStatusById = new Map(
      this.options.getFiles().map((file) => [file.id, file.status])
    );
    const removedIds = new Set<string>();

    for (const id of this.completedFileIds) {
      const liveStatus = liveStatusById.get(id);
      if (
        liveStatus !== undefined &&
        (liveStatus === UploadStatus.ERROR ||
          isUploadInFlight(liveStatus))
      ) {
        this.completedFileIds.delete(id);
        continue;
      }

      const file = byId.get(id);
      if (!file) {
        this.completedFileIds.delete(id);
        continue;
      }

      // P2-2：失败保留、重新上传中的文件也保留（但都从待清理集合移除）
      if (file.status === UploadStatus.ERROR || isUploadInFlight(file.status)) {
        this.completedFileIds.delete(id);
        continue;
      }

      if (canCleanup(file.status)) {
        removedIds.add(id);
      }
      // 可清理的 id 留在集合里，供 cleanupCompletedFilesFromUI 同步 UI；
      // 不可识别的历史状态保守保留在 DB 与 UI，避免「文件凭空消失」。
    }

    await Promise.all(
      Array.from(removedIds, (id) => this.options.storage.removeItem(id))
    );
    for (const id of removedIds) {
      this.options.fileRegistry.releaseFileRef(id);
      // 方案 A：记录被自动清理时同步回收分片缓存（完成时已清，这里兜底）。
      void clearFileChunkCache(
        this.options.instanceId ?? "default",
        id
      );
    }

    // 用已知快照刷新：整个清理流程只发生 1 次 iterate。
    const nextFiles =
      removedIds.size > 0
        ? snapshot.filter((file) => !removedIds.has(file.id))
        : snapshot;
    await this.options.refreshFiles(nextFiles);
  }

  cleanupCompletedFilesFromUI() {
    if (this.completedFileIds.size === 0) {
      return;
    }

    const ids = new Set(this.completedFileIds);
    const currentFiles = this.options.getFiles();

    const nextFiles = currentFiles.filter((file) => {
      if (!ids.has(file.id)) {
        return true;
      }

      // P2-2：重新上传中的文件必须留下，并从待清理集合移除
      if (file.status === UploadStatus.ERROR || isUploadInFlight(file.status)) {
        this.completedFileIds.delete(file.id);
        return true;
      }

      this.completedFileIds.delete(file.id);
      return !canCleanup(file.status);
    });

    this.options.setFiles(nextFiles);
  }

  async forceCleanupUI() {
    this.dispose();

    await this.cleanupCompletedFilesFromIndexedDB();
    this.cleanupCompletedFilesFromUI();
    // VU-50：cleanupCompletedFilesFromIndexedDB 已用快照刷新过一次，不再重复。
  }

  private startCountdown(seconds: number) {
    this.dispose();

    this.countdownValue = seconds;
    this.options.setBatchInfo((prev) => {
      if (!prev) {
        return null;
      }

      return {
        ...prev,
        countdown: this.countdownValue,
      };
    });

    // 单一触发源：仅由 setInterval 倒计时驱动清理，
    // 不再附加 setTimeout 兜底（避免双触发与后台标签页定时器不失效）
    this.countdownTimer = window.setInterval(() => {
      this.countdownValue -= 1;

      this.options.setBatchInfo((prev) => {
        if (!prev) {
          return null;
        }

        return {
          ...prev,
          countdown: this.countdownValue,
        };
      });

      if (this.countdownValue <= 0) {
        void this.executeCleanup();
      }
    }, 1000);
  }

  private async executeCleanup() {
    this.dispose();

    // VU-43：ERROR 状态的筛选已在 cleanupCompletedFilesFromIndexedDB 的
    // 单次快照里完成，不再为每个 id 单独读一遍。
    await this.cleanupCompletedFilesFromIndexedDB();
    this.cleanupCompletedFilesFromUI();
    // VU-50：refreshFiles 收敛到上面的快照刷新一次；延迟清空的 timer 纳入
    // dispose 管理，组件卸载后不再写 store。
    this.clearBatchInfoTimer = window.setTimeout(() => {
      this.clearBatchInfoTimer = null;
      this.options.clearBatchInfo();
    }, 1000);
  }
}
