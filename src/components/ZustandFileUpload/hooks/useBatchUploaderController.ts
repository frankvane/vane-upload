import { UploadFile, UploadStatus } from "../types/upload";

import { loadAllUploadFiles, runConcurrentQueue } from "../services/uploadOrchestrator";
import { useUploadStore } from "../store/upload";
import { useUploadEngine } from "../context/UploadEngineContext";
import { useEffectiveUploadConfig } from "./useEffectiveConfig";
import { useShallow } from "zustand/react/shallow";
import { isUploadableStatus } from "../services/uploadStorage";
import { resolveAuthHeaders } from "../utils/auth";
import {
  applyBeforeEach,
  applyFinalized,
  applySettled,
  classifyUploadResult,
  createInitialBatchInfo,
  isUploadSuccessKind,
} from "./uploadPolicy";
import { useUploaderLifecycle } from "./useUploaderLifecycle";

export interface RetrySummary {
  success: boolean;
  message: string;
  retriedCount: number;
}

export interface BatchUploaderActions {
  uploadAll: () => Promise<boolean>;
  cancelUpload: () => void;
  clearBatchInfo: () => void;
  pauseUploadFile: (file: UploadFile) => Promise<void>;
  resumeUploadFile: (file: UploadFile) => Promise<void>;
  retryUploadFile: (
    file: UploadFile
  ) => Promise<{ success: boolean; message: string }>;
  retryAllFailedFiles: () => Promise<RetrySummary>;
  forceCleanupUI: () => Promise<void>;
  pendingCleanupCount: () => number;
}

export function useBatchUploader(): BatchUploaderActions {
  const {
    isNetworkOffline,
    networkType,
    fileConcurrency,
    chunkConcurrency,
    chunkSize,
    maxRetries,
    refreshFiles,
    setProgressMap,
    setSpeedMap,
    setEtaMap,
    setBatchInfo,
    setIsUploading,
    getMessageApi,
  } = useUploadStore(
    useShallow((state) => ({
      isNetworkOffline: state.isNetworkOffline,
      networkType: state.networkType,
      fileConcurrency: state.fileConcurrency,
      chunkConcurrency: state.chunkConcurrency,
      chunkSize: state.chunkSize,
      maxRetries: state.maxRetries,
      refreshFiles: state.refreshFiles,
      setProgressMap: state.setProgressMap,
      setSpeedMap: state.setSpeedMap,
      setEtaMap: state.setEtaMap,
      setBatchInfo: state.setBatchInfo,
      setIsUploading: state.setIsUploading,
      getMessageApi: state.getMessageApi,
    }))
  );

  const uploadConfig = useEffectiveUploadConfig();
  const messageApi = getMessageApi();
  const engine = useUploadEngine();

  const {
    cleanupPolicy,
    activeUploadAbortRef,
    beginBatchSession,
    endBatchSession,
    flushRefresh,
    scheduleRefresh,
  } = useUploaderLifecycle({
    engine,
    refreshFiles,
    setBatchInfo,
    autoCleanup: uploadConfig.autoCleanup,
  });

  const processFileUpload = async (
    file: UploadFile,
    signal?: AbortSignal
  ): Promise<boolean> => {
    if (signal?.aborted) {
      return false;
    }

    // T3.1：文件字节不再驻留 IndexedDB，改由主线程 fileRegistry 持有运行时引用。
    // 页面刷新后注册表清空 → 需用户重新选择同一文件方可续传（服务端分片检查决定跳过范围）。
    const fileRef = engine.fileRegistry.getFileRef(file.id);
    if (!fileRef) {
      file.status = UploadStatus.ERROR;
      file.progress = 0;
      file.errorMessage = "文件引用已失效，请重新选择该文件以继续上传";
      file.awaitingReselect = true;
      await engine.storage.setItem(file.id, file);
      scheduleRefresh();
      return false;
    }

    file.status = UploadStatus.UPLOADING;
    await engine.storage.setItem(file.id, file);
    scheduleRefresh();

    const result = await engine.workerPool.runUploadTask({
      file,
      fileRef,
      signal,
      networkParams: {
        networkType,
        fileConcurrency,
        chunkConcurrency,
        chunkSize,
        maxRetries,
      },
      uploadConfig: {
        baseURL: uploadConfig.baseURL,
        uploadApi: uploadConfig.uploadApi,
        checkApi: uploadConfig.checkApi,
        mergeApi: uploadConfig.mergeApi,
        authHeaders: await resolveAuthHeaders(uploadConfig),
        withCredentials: uploadConfig.withCredentials,
        debug: uploadConfig.debug,
        hashMode: uploadConfig.hashMode,
      },
      onProgress: (detail) => {
        setProgressMap((prev) => ({
          ...prev,
          [file.id]: detail.progress,
        }));
        setSpeedMap((prev) => ({
          ...prev,
          [file.id]: detail.speed,
        }));
        setEtaMap((prev) => ({
          ...prev,
          [file.id]: detail.eta,
        }));

        // 旧签名（number）保留兼容；新签名（detail）提供速率/剩余时间
        uploadConfig.onUploadProgress?.(file, detail.progress);
        uploadConfig.onUploadProgressDetail?.(file, detail);
      },
    });

    const latest = (await engine.storage.getItem<UploadFile>(file.id)) ?? file;
    const kind = classifyUploadResult(result);

    if (kind.kind === "cancelled") {
      // 取消语义：状态回 QUEUED 可重新入队（保留 fileRef 以便后续重传/续传）
      latest.status = UploadStatus.QUEUED;
      latest.errorMessage = undefined;
      latest.awaitingReselect = false;
      await engine.storage.setItem(file.id, latest);
      scheduleRefresh();
      return false;
    }

    if (kind.kind === "paused") {
      // T3.3：分片边界暂停，状态置 PAUSED；保留 fileRef 以便续传，
      // 记录已上传分片索引（pausedChunks）供 UI 展示。
      latest.status = UploadStatus.PAUSED;
      latest.progress =
        engine.store.getState().progressMap[file.id] ?? latest.progress ?? 0;
      latest.errorMessage = undefined;
      latest.awaitingReselect = false;
      if (typeof kind.pausedChunks === "number" && kind.pausedChunks > 0) {
        latest.pausedChunks = Array.from(
          { length: kind.pausedChunks },
          (_, k) => k
        );
      }
      await engine.storage.setItem(file.id, latest);
      scheduleRefresh();
      return false;
    }

    if (isUploadSuccessKind(kind)) {
      latest.status = kind.skipped ? UploadStatus.INSTANT : UploadStatus.DONE;
      latest.progress = 100;
      latest.errorMessage = undefined;
      // 上传完成：释放文件引用，避免 File 句柄长期驻留
      engine.fileRegistry.releaseFileRef(file.id);

      await engine.storage.setItem(file.id, latest);
      scheduleRefresh();

      uploadConfig.onUploadComplete?.(latest, true);
      await cleanupPolicy.addCompletedFile(file.id);
      return true;
    }

    // 失败分支
    latest.status = UploadStatus.ERROR;
    latest.errorMessage = kind.message;
    await engine.storage.setItem(file.id, latest);
    scheduleRefresh();

    uploadConfig.onUploadError?.(latest, kind.message);
    return false;
  };

  const finalizeBatch = async (
    summary: { successCount: number; failedCount: number },
    total: number
  ) => {
    setIsUploading(false);
    await flushRefresh();

    setBatchInfo((prev) =>
      applyFinalized(prev, summary, total, {
        autoCleanup: uploadConfig.autoCleanup,
        cleanupDelay: uploadConfig.cleanupDelay,
      })
    );

    uploadConfig.onBatchComplete?.({
      success: summary.successCount,
      failed: summary.failedCount,
      total,
    });

    if (uploadConfig.autoCleanup && cleanupPolicy.pendingCount() > 0) {
      cleanupPolicy.scheduleCleanup(uploadConfig.cleanupDelay);
    }
  };

  const uploadAll = async (): Promise<boolean> => {
    if (isNetworkOffline) {
      messageApi.error("网络已断开，无法上传文件");
      return false;
    }

    const allFiles = await loadAllUploadFiles(engine.storage);
    const uploadableFiles = allFiles.filter((file) => isUploadableStatus(file.status));

    if (uploadableFiles.length === 0) {
      messageApi.info("没有需要上传的文件");
      setIsUploading(false);
      return false;
    }

    const batchController = beginBatchSession();
    setIsUploading(true);

    uploadConfig.onUploadStart?.(uploadableFiles);

    setBatchInfo(createInitialBatchInfo(uploadableFiles.length));

    try {
      const summary = await runConcurrentQueue({
        items: uploadableFiles,
        concurrency: Math.min(fileConcurrency, uploadableFiles.length),
        shouldStop: () => batchController.signal.aborted,
        beforeEach: async (file) => {
          if (batchController.signal.aborted) {
            return;
          }

          file.status = UploadStatus.PREPARING_UPLOAD;
          file.progress = 0;
          await engine.storage.setItem(file.id, file);
          scheduleRefresh();

          setBatchInfo(applyBeforeEach);
        },
        task: (file) => processFileUpload(file, batchController.signal),
        onSettled: async ({ success }) => {
          if (batchController.signal.aborted) {
            return;
          }

          setBatchInfo((prev) => applySettled(prev, success));
          scheduleRefresh();
        },
      });

      if (batchController.signal.aborted) {
        return false;
      }

      await finalizeBatch(summary, uploadableFiles.length);
      return true;
    } finally {
      endBatchSession(batchController);
    }
  };

  const cancelUpload = () => {
    const activeController = activeUploadAbortRef.current;
    if (activeController && !activeController.signal.aborted) {
      activeController.abort();
      messageApi.info("已取消当前上传任务");
    }

    // P1-8：abort 只会让主线程 Promise 落败，Worker 内在途 fetch 需显式
    // CANCEL 才会中断（bridge 收到 signal 后会 terminate 兜底）
    const uploadingFiles = engine.store
      .getState()
      .files.filter((file) => file.status === UploadStatus.UPLOADING);
    for (const file of uploadingFiles) {
      engine.workerPool.cancelUploadTask(file.id);
    }

    // T3.3：PAUSED 文件无存活 Worker 任务，直接复位为待上传
    const pausedFiles = engine.store
      .getState()
      .files.filter((file) => file.status === UploadStatus.PAUSED);
    for (const file of pausedFiles) {
      engine.store.getState().patchFile(file.id, {
        status: UploadStatus.QUEUED,
        errorMessage: undefined,
        awaitingReselect: false,
      });
      const updated = {
        ...file,
        status: UploadStatus.QUEUED,
        errorMessage: undefined,
        awaitingReselect: false,
      };
      void engine.storage.setItem(file.id, updated);
    }

    setIsUploading(false);
    setBatchInfo(null);
  };

  const pauseUploadFile = async (file: UploadFile) => {
    if (file.status !== UploadStatus.UPLOADING) {
      return;
    }
    // 乐观更新：立即在内存与持久化中置 PAUSED，并通知 Worker 分片边界暂停
    engine.store.getState().patchFile(file.id, {
      status: UploadStatus.PAUSED,
      errorMessage: undefined,
    });
    await engine.storage.setItem(file.id, {
      ...file,
      status: UploadStatus.PAUSED,
      errorMessage: undefined,
    });
    scheduleRefresh();
    engine.workerPool.pauseUploadTask(file.id);
  };

  const resumeUploadFile = async (file: UploadFile) => {
    if (file.status !== UploadStatus.PAUSED) {
      return;
    }
    // 优先解除 Worker 内挂起（会话内暂停：不重传，从断点续传）
    const alive = engine.workerPool.resumeUploadTask(file.id);
    if (alive) {
      engine.store.getState().patchFile(file.id, {
        status: UploadStatus.UPLOADING,
        errorMessage: undefined,
      });
      await engine.storage.setItem(file.id, {
        ...file,
        status: UploadStatus.UPLOADING,
        errorMessage: undefined,
      });
      scheduleRefresh();
      return;
    }

    // Worker 已释放（刷新/卸载后）：重新发起上传，服务端分片校验保证字节级续传
    const fileRef = engine.fileRegistry.getFileRef(file.id);
    if (!fileRef) {
      engine.store.getState().patchFile(file.id, {
        status: UploadStatus.ERROR,
        errorMessage: "文件引用已失效，请重新选择该文件以继续上传",
        awaitingReselect: true,
      });
      await engine.storage.setItem(file.id, {
        ...file,
        status: UploadStatus.ERROR,
        errorMessage: "文件引用已失效，请重新选择该文件以继续上传",
        awaitingReselect: true,
      });
      scheduleRefresh();
      messageApi.warning("请重新选择文件以继续上传");
      return;
    }
    // 复用上传链路：服务端 instant 校验已传分片并跳过，字节级续传
    void processFileUpload(
      { ...file, status: UploadStatus.UPLOADING, progress: file.progress ?? 0 },
      undefined
    );
  };

  const clearBatchInfo = () => {
    setBatchInfo(null);
  };

  const retryUploadFile = async (
    file: UploadFile
  ): Promise<{ success: boolean; message: string }> => {
    if (isNetworkOffline) {
      return {
        success: false,
        message: "网络已断开，无法重试上传",
      };
    }

    file.status = UploadStatus.PREPARING_UPLOAD;
    file.progress = 0;
    file.errorMessage = undefined;
    await engine.storage.setItem(file.id, file);

    try {
      const success = await processFileUpload(file);
      await flushRefresh();

      if (success && uploadConfig.autoCleanup && cleanupPolicy.pendingCount() > 0) {
        cleanupPolicy.scheduleCleanup(uploadConfig.cleanupDelay);
      }

      return {
        success,
        message: success ? "重试上传成功" : "重试上传失败",
      };
    } catch {
      return {
        success: false,
        message: "重试上传时发生错误",
      };
    }
  };

  const retryAllFailedFiles = async (): Promise<RetrySummary> => {
    if (isNetworkOffline) {
      return {
        success: false,
        message: "网络已断开，无法重试上传",
        retriedCount: 0,
      };
    }

    const allFiles = await loadAllUploadFiles(engine.storage);
    const failedFiles = allFiles.filter((file) => file.status === UploadStatus.ERROR);

    if (failedFiles.length === 0) {
      return {
        success: false,
        message: "没有需要重试的文件",
        retriedCount: 0,
      };
    }

    const batchController = beginBatchSession();
    setIsUploading(true);
    setBatchInfo(createInitialBatchInfo(failedFiles.length, failedFiles.length));

    try {
      const summary = await runConcurrentQueue({
        items: failedFiles,
        concurrency: Math.min(fileConcurrency, failedFiles.length),
        shouldStop: () => batchController.signal.aborted,
        beforeEach: async (file) => {
          if (batchController.signal.aborted) {
            return;
          }

          file.status = UploadStatus.PREPARING_UPLOAD;
          file.progress = 0;
          file.errorMessage = undefined;
          await engine.storage.setItem(file.id, file);

          setBatchInfo(applyBeforeEach);
        },
        task: (file) => processFileUpload(file, batchController.signal),
        onSettled: ({ success }) => {
          if (batchController.signal.aborted) {
            return;
          }

          setBatchInfo((prev) => applySettled(prev, success));
        },
      });

      if (batchController.signal.aborted) {
        return {
          success: false,
          message: "批量重试已取消",
          retriedCount: 0,
        };
      }

      await finalizeBatch(summary, failedFiles.length);

      return {
        success: summary.failedCount === 0,
        message: `重试完成: ${summary.successCount}个成功, ${summary.failedCount}个失败`,
        retriedCount: failedFiles.length,
      };
    } finally {
      endBatchSession(batchController);
    }
  };

  const forceCleanupUI = async () => {
    await cleanupPolicy.forceCleanupUI();
  };

  return {
    uploadAll,
    cancelUpload,
    clearBatchInfo,
    pauseUploadFile,
    resumeUploadFile,
    retryUploadFile,
    retryAllFailedFiles,
    forceCleanupUI,
    pendingCleanupCount: () => cleanupPolicy.pendingCount(),
  };
}
