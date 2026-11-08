import { useCallback, useMemo } from "react";
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

/**
 * VU-42：所有 action 用 useCallback 稳定身份、返回对象用 useMemo 稳定身份。
 * 依赖只含 store 原语 / 稳定 action / 已稳定的 engine 与 config 对象，
 * 因此每条进度消息引起的父级重渲染不再击穿下游 props 与 useEffect。
 */
export function useBatchUploader(): BatchUploaderActions {
  const {
    isNetworkOffline,
    networkType,
    fileConcurrency,
    chunkConcurrency,
    chunkSize,
    maxRetries,
    refreshFiles,
    setProgressDetail,
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
      setProgressDetail: state.setProgressDetail,
      setBatchInfo: state.setBatchInfo,
      setIsUploading: state.setIsUploading,
      getMessageApi: state.getMessageApi,
    }))
  );

  const uploadConfig = useEffectiveUploadConfig();
  const engine = useUploadEngine();

  const {
    cleanupPolicy,
    activeUploadAbortRef,
    beginBatchSession,
    endBatchSession,
    syncFile,
    flushRefresh,
  } = useUploaderLifecycle({
    engine,
    refreshFiles,
    setBatchInfo,
    autoCleanup: uploadConfig.autoCleanup,
  });

  const processFileUpload = useCallback(
    async (file: UploadFile, signal?: AbortSignal): Promise<boolean> => {
      if (signal?.aborted) {
        return false;
      }

      // E2E-03：文件可能在排队 / 预处理期间被删除。记录已不存在时不得写回
      // 任何状态（包括 ERROR），否则刷新后列表会「复活」这条记录并继续上传。
      if (!(await engine.storage.getItem<UploadFile>(file.id))) {
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
        syncFile(file);
        return false;
      }

      file.status = UploadStatus.UPLOADING;
      await engine.storage.setItem(file.id, file);
      syncFile(file);

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
          // VU-40：三张 map 一次原子更新，订阅者只收到 1 次通知。
          setProgressDetail(file.id, {
            progress: detail.progress,
            speed: detail.speed,
            eta: detail.eta,
          });

          // 旧签名（number）保留兼容；新签名（detail）提供速率/剩余时间
          uploadConfig.onUploadProgress?.(file, detail.progress);
          uploadConfig.onUploadProgressDetail?.(file, detail);
        },
      });

      // E2E-03：任务结束前记录被删除（删除即中止）时直接收尾，绝不写回。
      // 旧实现回退到内存里的 file 对象，cancelled/paused/error/success 分支
      // 都会把已删除的记录重新 setItem，造成刷新后「复活」。
      const persisted = await engine.storage.getItem<UploadFile>(file.id);
      if (!persisted) {
        return false;
      }
      const latest = persisted;
      const kind = classifyUploadResult(result);

      if (kind.kind === "cancelled") {
        // 取消语义：状态回 QUEUED 可重新入队（保留 fileRef 以便后续重传/续传）
        latest.status = UploadStatus.QUEUED;
        latest.errorMessage = undefined;
        latest.awaitingReselect = false;
        await engine.storage.setItem(file.id, latest);
        syncFile(latest);
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
        syncFile(latest);
        return false;
      }

      if (isUploadSuccessKind(kind)) {
        latest.status = kind.skipped ? UploadStatus.INSTANT : UploadStatus.DONE;
        latest.progress = 100;
        latest.errorMessage = undefined;
        // 上传完成：释放文件引用，避免 File 句柄长期驻留
        engine.fileRegistry.releaseFileRef(file.id);

        await engine.storage.setItem(file.id, latest);
        syncFile(latest);

        uploadConfig.onUploadComplete?.(latest, true);
        await cleanupPolicy.addCompletedFile(file.id);
        return true;
      }

      // 失败分支
      latest.status = UploadStatus.ERROR;
      latest.errorMessage = kind.message;
      await engine.storage.setItem(file.id, latest);
      syncFile(latest);

      uploadConfig.onUploadError?.(latest, kind.message);
      return false;
    },
    [
      engine,
      syncFile,
      networkType,
      fileConcurrency,
      chunkConcurrency,
      chunkSize,
      maxRetries,
      setProgressDetail,
      uploadConfig,
      cleanupPolicy,
    ]
  );

  const finalizeBatch = useCallback(
    async (
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
    },
    [setIsUploading, flushRefresh, setBatchInfo, uploadConfig, cleanupPolicy]
  );

  const uploadAll = useCallback(async (): Promise<boolean> => {
    if (isNetworkOffline) {
      getMessageApi().error("网络已断开，无法上传文件");
      return false;
    }

    const allFiles = await loadAllUploadFiles(engine.storage);
    const uploadableFiles = allFiles.filter((file) => isUploadableStatus(file.status));

    if (uploadableFiles.length === 0) {
      getMessageApi().info("没有需要上传的文件");
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

          // E2E-03：排队期间被删除的文件不得再写回 PREPARING_UPLOAD。
          if (!(await engine.storage.getItem<UploadFile>(file.id))) {
            return;
          }

          file.status = UploadStatus.PREPARING_UPLOAD;
          file.progress = 0;
          await engine.storage.setItem(file.id, file);
          syncFile(file);

          setBatchInfo(applyBeforeEach);
        },
        task: (file) => processFileUpload(file, batchController.signal),
        onSettled: async ({ item, success }) => {
          if (batchController.signal.aborted) {
            return;
          }

          setBatchInfo((prev) => applySettled(prev, success));
          syncFile(item);
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
  }, [
    isNetworkOffline,
    getMessageApi,
    engine,
    beginBatchSession,
    endBatchSession,
    setIsUploading,
    uploadConfig,
    fileConcurrency,
    processFileUpload,
    syncFile,
    setBatchInfo,
    finalizeBatch,
  ]);

  const cancelUpload = useCallback(() => {
    const activeController = activeUploadAbortRef.current;
    if (activeController && !activeController.signal.aborted) {
      activeController.abort();
      getMessageApi().info("已取消当前上传任务");
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
  }, [
    activeUploadAbortRef,
    getMessageApi,
    engine,
    setIsUploading,
    setBatchInfo,
  ]);

  const pauseUploadFile = useCallback(
    async (file: UploadFile) => {
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
      // VU-18：上面的 patchFile 已即时同步 UI，无需再排队一次全量 IDB 读。
      engine.workerPool.pauseUploadTask(file.id);
    },
    [engine]
  );

  const resumeUploadFile = useCallback(
    async (file: UploadFile) => {
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
        getMessageApi().warning("请重新选择文件以继续上传");
        return;
      }
      // 复用上传链路：服务端 instant 校验已传分片并跳过，字节级续传
      void processFileUpload(
        { ...file, status: UploadStatus.UPLOADING, progress: file.progress ?? 0 },
        undefined
      );
    },
    [engine, getMessageApi, processFileUpload]
  );

  const clearBatchInfo = useCallback(() => {
    setBatchInfo(null);
  }, [setBatchInfo]);

  const retryUploadFile = useCallback(
    async (file: UploadFile): Promise<{ success: boolean; message: string }> => {
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
    },
    [
      isNetworkOffline,
      engine,
      processFileUpload,
      flushRefresh,
      uploadConfig,
      cleanupPolicy,
    ]
  );

  const retryAllFailedFiles = useCallback(async (): Promise<RetrySummary> => {
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

          // E2E-03：排队期间被删除的文件不得再写回 PREPARING_UPLOAD。
          if (!(await engine.storage.getItem<UploadFile>(file.id))) {
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
  }, [
    isNetworkOffline,
    engine,
    fileConcurrency,
    beginBatchSession,
    endBatchSession,
    setIsUploading,
    setBatchInfo,
    processFileUpload,
    finalizeBatch,
  ]);

  const forceCleanupUI = useCallback(async () => {
    await cleanupPolicy.forceCleanupUI();
  }, [cleanupPolicy]);

  const pendingCleanupCount = useCallback(
    () => cleanupPolicy.pendingCount(),
    [cleanupPolicy]
  );

  return useMemo(
    () => ({
      uploadAll,
      cancelUpload,
      clearBatchInfo,
      pauseUploadFile,
      resumeUploadFile,
      retryUploadFile,
      retryAllFailedFiles,
      forceCleanupUI,
      pendingCleanupCount,
    }),
    [
      uploadAll,
      cancelUpload,
      clearBatchInfo,
      pauseUploadFile,
      resumeUploadFile,
      retryUploadFile,
      retryAllFailedFiles,
      forceCleanupUI,
      pendingCleanupCount,
    ]
  );
}
