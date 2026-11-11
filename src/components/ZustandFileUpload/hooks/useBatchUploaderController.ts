import { useCallback, useMemo, useRef } from "react";
import { BatchInfo, UploadFile, UploadStatus } from "../types/upload";

import {
  loadAllUploadFiles,
  runConcurrentQueue,
  type BeforeEachOutcome,
  type QueueSummary,
} from "../services/uploadOrchestrator";
import { useUploadStore } from "../store/upload";
import { useUploadEngine } from "../context/UploadEngineContext";
import { useEffectiveUploadConfig } from "./useEffectiveConfig";
import { useShallow } from "zustand/react/shallow";
import { isUploadableStatus } from "../services/uploadStorage";
import {
  clearFileChunkCache,
  isFileCacheReady,
  primeChunkCache,
} from "../services/chunkCache";
import { resolveAuthHeaders } from "../utils/auth";
import {
  applyBeforeEach,
  applyFinalized,
  applySettled,
  applySettledCancelled,
  applySettledSkipped,
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
  /**
   * E2E-R4：取消单个文件的上传——中止传输但保留记录（状态置 PAUSED，
   * 可点「继续」重新开始），与「删除」（移除记录 + 清理服务端分片与本地缓存）区分。
   */
  cancelUploadFile: (file: UploadFile) => Promise<void>;
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
    fileConcurrency,
    chunkConcurrency,
    maxRetries,
    refreshFiles,
    setProgressDetail,
    setBatchInfo,
    setIsUploading,
    getMessageApi,
  } = useUploadStore(
    useShallow((state) => ({
      isNetworkOffline: state.isNetworkOffline,
      fileConcurrency: state.fileConcurrency,
      chunkConcurrency: state.chunkConcurrency,
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

  /**
   * E2E-R4：用户显式「取消上传」的文件 id。
   * - userCancelledIds：Worker 返回 cancelled 时据此写 PAUSED（而非回 QUEUED）；
   * - cancelledInBatchIds：批次结算时跳过成功/失败计数，避免取消污染批量统计。
   */
  const userCancelledIdsRef = useRef<Set<string>>(new Set());
  const cancelledInBatchIdsRef = useRef<Set<string>>(new Set());
  // T-32：本批被「暂停」的文件。暂停是可继续的中断，与取消同口径：推进批次进度，
  // 但既不计成功也不计失败，否则悬浮条会显示「1 个失败」且重试全部会误重试。
  const pausedInBatchIdsRef = useRef<Set<string>>(new Set());

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

      // 分片缓存：会话内优先用 fileRef；刷新后 fileRef 丢失，缓存就绪即可零点击续传。
      //
      // 预热不阻塞上传启动：上传字节来自 fileRef（会话内）或缓存（刷新后），
      // 二者互不依赖；等全量预热会让首字节延迟正比于文件大小。
      // 安全性只依赖 chunkCache「就绪标记最后写入」：标记存在 ⟹ 分片齐全；
      // 预热未完成时刷新 → 无标记 → 降级为「需重新选择」，不新增失败模式。
      const fileRef = engine.fileRegistry.getFileRef(file.id);
      const cacheOptions = {
        instanceId: engine.instanceId,
        maxFileSize: uploadConfig.chunkCacheMaxFileSize,
      };

      if (!fileRef) {
        // 刷新后续传：缓存是唯一字节来源，必须确认就绪（此时也没有可并行的预热）。
        if (!(await isFileCacheReady(engine.instanceId, file.id))) {
          file.status = UploadStatus.ERROR;
          file.progress = 0;
          file.errorMessage = "本地续传缓存缺失，请重新选择该文件以继续上传";
          file.awaitingReselect = true;
          await engine.storage.setItem(file.id, file);
          syncFile(file);
          return false;
        }
      } else {
        // 会话内上传：预热在后台继续推进（幂等，接上选文件阶段那次），不进关键路径。
        void primeChunkCache(file, fileRef, cacheOptions).catch(() => undefined);
      }

      file.status = UploadStatus.UPLOADING;
      await engine.storage.setItem(file.id, file);
      syncFile(file);

      const result = await engine.workerPool.runUploadTask({
        file,
        fileRef,
        chunkCache: { instanceId: engine.instanceId },
        signal,
        networkParams: {
          chunkConcurrency,
          maxRetries,
        },
        uploadConfig: {
          baseURL: uploadConfig.baseURL,
          uploadApi: uploadConfig.uploadApi,
          checkApi: uploadConfig.checkApi,
          mergeApi: uploadConfig.mergeApi,
          statusApi: uploadConfig.statusApi,
          authHeaders: await resolveAuthHeaders(uploadConfig),
          withCredentials: uploadConfig.withCredentials,
          debug: uploadConfig.debug,
          hashMode: uploadConfig.hashMode,
        },
        onProgress: (detail) => {
          // 宿主回调一律隔离：抛异常不能把已完成的上传误判为失败（T-33）。
          try {
            // VU-40：三张 map 一次原子更新，订阅者只收到 1 次通知。
            setProgressDetail(file.id, {
              progress: detail.progress,
              speed: detail.speed,
              eta: detail.eta,
            });

            // 旧签名（number）保留兼容；新签名（detail）提供速率/剩余时间
            uploadConfig.onUploadProgress?.(file, detail.progress);
            uploadConfig.onUploadProgressDetail?.(file, detail);
          } catch {
            // 进度展示失败不影响上传链路
          }
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
        // E2E-R4：用户显式「取消上传」→ 置 PAUSED（保留记录与进度，可点「继续」
        // 重新开始）；批级取消（cancelUpload）仍回 QUEUED 等待重新入队。
        const userCancelled = userCancelledIdsRef.current.delete(file.id);
        latest.status = userCancelled
          ? UploadStatus.PAUSED
          : UploadStatus.QUEUED;
        if (userCancelled) {
          latest.progress =
            engine.store.getState().progressMap[file.id] ?? latest.progress ?? 0;
        }
        latest.errorMessage = undefined;
        latest.awaitingReselect = false;
        await engine.storage.setItem(file.id, latest);
        syncFile(latest);
        return false;
      }

      if (kind.kind === "paused") {
        // T3.3：分片边界暂停，状态置 PAUSED；保留 fileRef 以便续传，
        // 记录已上传分片索引（pausedChunks）供 UI 展示。
        // T-32：登记为本批「暂停」，批次结算时从 failedCount 剔除。
        pausedInBatchIdsRef.current.add(file.id);
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
        // 已完成（含秒传）：分片缓存不再需要，立即清理；Worker 成功路径同样会删。
        void clearFileChunkCache(engine.instanceId, file.id);

        await engine.storage.setItem(file.id, latest);
        syncFile(latest);

        // T-33：宿主回调失败不改变「文件已成功落盘」这一事实。
        try {
          uploadConfig.onUploadComplete?.(latest, true);
        } catch {
          // 宿主自行处理回调异常
        }
        await cleanupPolicy.addCompletedFile(file.id);
        return true;
      }

      // 失败分支：终态不再重试，回收分片缓存，避免长期占用存储。
      // 缓存缺片本身已无缓存可清；该情形明确标记「需重新选择文件」。
      latest.status = UploadStatus.ERROR;
      latest.errorMessage = kind.message;
      if (kind.cacheMissing) {
        latest.awaitingReselect = true;
      }
      void clearFileChunkCache(engine.instanceId, file.id);
      await engine.storage.setItem(file.id, latest);
      syncFile(latest);

      try {
        uploadConfig.onUploadError?.(latest, kind.message);
      } catch {
        // 宿主回调失败不改变「文件已失败」这一事实
      }
      return false;
    },
    [
      engine,
      syncFile,
      chunkConcurrency,
      maxRetries,
      setProgressDetail,
      uploadConfig,
      cleanupPolicy,
    ]
  );

  const finalizeBatch = useCallback(
    async (
      summary: { successCount: number; failedCount: number; skippedCount?: number },
      total: number
    ) => {
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
        skipped: summary.skippedCount ?? 0,
      });

      if (uploadConfig.autoCleanup && cleanupPolicy.pendingCount() > 0) {
        cleanupPolicy.scheduleCleanup(uploadConfig.cleanupDelay);
      }
    },
    [setBatchInfo, uploadConfig, cleanupPolicy]
  );

  /**
   * T-08：批次编排唯一实现。
   *
   * 「上传全部」与「重试全部」原本各写一份 `beginBatchSession → runConcurrentQueue →
   * finalizeBatch`，差异只有三处（是否重置取消计数、是否同步 store 行、
   * 批结束怎么算失败数）。两份实现各自演进时，「取消不计入失败」这条语义要改两遍，
   * 漏一处就出现「点全部重试后取消，失败数凭空多 1」。
   *
   * 现在把三处差异收敛成两个开关，并把**取消不该计失败**的账算在这里：
   * 返回的 `summary.failedCount` 已经剔除本批被用户取消的任务。
   */
  const runBatch = useCallback(
    async (
      files: UploadFile[],
      options: {
        /** 起始批信息；重试批的 retryTotal 之类的差异由调用方算好传进来 */
        batchInfo: BatchInfo;
        /** 新批次是否重置取消计数（连续两次「上传全部」之间必须重置） */
        resetCancelCounters?: boolean;
        /** 是否按「用户取消」剔除失败数（uploadAll 需要，重试批沿用原始口径） */
        trackCancelled?: boolean;
        /** 行状态落盘后的回调（uploadAll 用它把新引用同步进 store） */
        onFileSynced?: (file: UploadFile) => void;
      }
    ): Promise<{ aborted: boolean; summary: QueueSummary }> => {
      const controller = beginBatchSession();
      setIsUploading(true);
      if (options.resetCancelCounters) {
        cancelledInBatchIdsRef.current.clear();
        pausedInBatchIdsRef.current.clear();
      }
      setBatchInfo(options.batchInfo);

      // 本批被取消 / 暂停并已结算的任务数：只在本批次内有效，不必做成 ref
      let cancelledCount = 0;
      let pausedCount = 0;

      try {
        const summary = await runConcurrentQueue({
          items: files,
          // T-36：并发数归一化交给编排器单点处理，非法值不会再变成空批次
          concurrency: fileConcurrency,
          shouldStop: () => controller.signal.aborted,
          beforeEach: async (file): Promise<BeforeEachOutcome> => {
            if (controller.signal.aborted) {
              return;
            }

            // E2E-03：排队期间被删除的文件不得再写回 PREPARING_UPLOAD。
            // T-14：返回 "skip" 让队列把这条记为「已跳过」，而不是落到 task 的
            // false 上去，凭空多出一个失败。
            if (!(await engine.storage.getItem<UploadFile>(file.id))) {
              return "skip";
            }

            file.status = UploadStatus.PREPARING_UPLOAD;
            file.progress = 0;
            file.errorMessage = undefined;
            await engine.storage.setItem(file.id, file);
            options.onFileSynced?.(file);

            setBatchInfo(applyBeforeEach);
          },
          task: (file) => processFileUpload(file, controller.signal),
          onSettled: ({ item, success, skipped }) => {
            if (controller.signal.aborted) {
              return;
            }

            // T-14：跳过的一件只推进批次进度，不计成功也不计失败。
            if (skipped) {
              setBatchInfo(applySettledSkipped);
              return;
            }

            // E2E-R4：被用户取消的文件既不算成功也不算失败，避免污染批量统计。
            if (options.trackCancelled && cancelledInBatchIdsRef.current.delete(item.id)) {
              cancelledCount += 1;
              setBatchInfo(applySettledCancelled);
            } else if (pausedInBatchIdsRef.current.delete(item.id)) {
              // T-32：暂停与取消同口径 —— 推进进度，既不计成功也不计失败
              pausedCount += 1;
              setBatchInfo(applySettledCancelled);
            } else {
              setBatchInfo((prev) => applySettled(prev, success));
            }
            options.onFileSynced?.(item);
          },
        });

        return {
          aborted: controller.signal.aborted,
          summary: {
            successCount: summary.successCount,
            // T-08 / T-32：用户取消与暂停都不算失败
            failedCount: Math.max(
              summary.failedCount - cancelledCount - pausedCount,
              0
            ),
            skippedCount: summary.skippedCount,
          },
        };
      } finally {
        endBatchSession(controller);
        // T-33：无论批次正常结束还是编排器抛异常，都必须复位上传态并刷新列表。
        // 放在 finally 而不是 finalizeBatch，异常路径才不会把 isUploading 永久卡在 true。
        setIsUploading(false);
        await flushRefresh();
      }
    },
    [
      engine,
      beginBatchSession,
      endBatchSession,
      setIsUploading,
      flushRefresh,
      setBatchInfo,
      fileConcurrency,
      processFileUpload,
    ]
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

    uploadConfig.onUploadStart?.(uploadableFiles);

    const { aborted, summary } = await runBatch(uploadableFiles, {
      batchInfo: createInitialBatchInfo(uploadableFiles.length),
      resetCancelCounters: true,
      trackCancelled: true,
      onFileSynced: syncFile,
    });

    if (aborted) {
      return false;
    }

    await finalizeBatch(summary, uploadableFiles.length);
    return true;
  }, [
    isNetworkOffline,
    getMessageApi,
    engine,
    setIsUploading,
    uploadConfig,
    runBatch,
    syncFile,
    finalizeBatch,
  ]);

  const cancelUpload = useCallback(() => {
    const state = engine.store.getState();
    const activeController = activeUploadAbortRef.current;
    if (activeController && !activeController.signal.aborted) {
      activeController.abort();
      getMessageApi().info("已取消当前上传任务");
    }

    // F-01：整批取消必须把「正在飞」的记录统一落定为 PAUSED。
    // 旧实现只 abort + cancelUploadTask，把收尾完全押在 Worker 回 cancelled 上：
    // Worker 若正卡在长同步哈希 / 大文件合并等待里收不到 cancel，任务 Promise
    // 永不 settle（见 uploadWorkerBridge 的兜底结算），行就永久停在「上传中 100%」，
    // 速率还冻结在最后一次采样值，既不能继续也没有报错。
    // 这里改为「乐观落定 + 标记用户取消」：UI 立刻可见，settle 后
    // cancelled 分支按 PAUSED 写回（口径一致，不会退回 QUEUED）。
    const interruptedFiles = state.files.filter(
      (file) =>
        file.status === UploadStatus.UPLOADING ||
        file.status === UploadStatus.PREPARING_UPLOAD ||
        file.status === UploadStatus.PAUSED
    );

    for (const file of interruptedFiles) {
      userCancelledIdsRef.current.add(file.id);
      cancelledInBatchIdsRef.current.add(file.id);

      // 向 Worker 发 cancel；若 Worker 无响应，bridge 兜底窗口后强制结算
      engine.workerPool.cancelUploadTask(file.id);

      const progress = state.progressMap[file.id] ?? file.progress ?? 0;
      engine.store.getState().patchFile(file.id, {
        status: UploadStatus.PAUSED,
        errorMessage: undefined,
        awaitingReselect: false,
      });
      // 冻结速率/ETA 归零：否则暂停后仍展示最后一次采样速度，看起来像「还在传」
      engine.store
        .getState()
        .setProgressDetail(file.id, { progress, speed: 0, eta: 0 });

      void engine.storage.setItem(file.id, {
        ...file,
        status: UploadStatus.PAUSED,
        progress,
        errorMessage: undefined,
        awaitingReselect: false,
      });
    }

    setIsUploading(false);
    setBatchInfo(null);

    // F-02：不再清理这些记录的分片缓存。
    // 旧实现「取消即清缓存」会让「继续」和「重试」都拿不到字节来源
    // （刷新后直接判缓存缺失、要求重新选择文件），等于取消一次就锁死该行。
    // 「取消后刷新不被自动拉起」的目标改由 PAUSED 语义保证：
    // isUploadableStatus 不包含 PAUSED，只有用户显式点「继续」才会续传。
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
      // D-05 方案 A：Worker 挂起状态机已删除，「继续」统一走主线程重跑续传——
      // 服务端 instant 校验已传分片并跳过，字节级续传；会话内 fileRef 优先，
      // 刷新后若分片缓存就绪同样可续传，只有两者都没有才降级重选。
      const fileRef = engine.fileRegistry.getFileRef(file.id);
      const hasCache = fileRef
        ? true
        : await isFileCacheReady(engine.instanceId, file.id);
      if (!hasCache) {
        engine.store.getState().patchFile(file.id, {
          status: UploadStatus.ERROR,
          errorMessage: "本地续传缓存缺失，请重新选择该文件以继续上传",
          awaitingReselect: true,
        });
        await engine.storage.setItem(file.id, {
          ...file,
          status: UploadStatus.ERROR,
          errorMessage: "本地续传缓存缺失，请重新选择该文件以继续上传",
          awaitingReselect: true,
        });
        getMessageApi().warning("本地续传缓存缺失，请重新选择文件以继续上传");
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

  /**
   * E2E-R4：取消单个文件的上传。
   * 与「删除」的区别：
   * - 取消：中止 Worker 传输，保留记录与进度（置 PAUSED，可点「继续」重新开始），
   *   不清理服务端分片，也不清理本地分片缓存；
   * - 删除：移除记录，并清理服务端分片与本地缓存（见 useFileOperations.handleDelete）。
   */
  const cancelUploadFile = useCallback(
    async (file: UploadFile) => {
      if (file.status !== UploadStatus.UPLOADING) {
        return;
      }

      // 标记「用户取消」意图：Worker 返回 cancelled 后写 PAUSED 而非回 QUEUED。
      userCancelledIdsRef.current.add(file.id);
      cancelledInBatchIdsRef.current.add(file.id);

      // 乐观更新：立即置 PAUSED，保留当前进度与 fileRef；缓存不清理，
      // 因此中断后既可点「继续」回归当前会话，也可刷新后走续传。
      engine.store.getState().patchFile(file.id, {
        status: UploadStatus.PAUSED,
        errorMessage: undefined,
      });
      await engine.storage.setItem(file.id, {
        ...file,
        status: UploadStatus.PAUSED,
        errorMessage: undefined,
      });

      engine.workerPool.cancelUploadTask(file.id);
      getMessageApi().info(
        `已取消「${file.fileName}」的上传，记录已保留，可点击「继续」重新开始`
      );
    },
    [engine, getMessageApi]
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

      // T-07：入参通常是 store 里的那个对象。原地改写它等于私改 React state ——
      // 数组引用不变、行组件的 props 引用不变，重试期间的「准备中」根本不会重渲染，
      // 而 `store.files` 里却已经是新值，DevTools 与实际渲染帧对不上。
      // 从入口复制一份 draft，之后所有写入都落在 draft 上，由 syncFile/patchFile 换引用。
      const draft: UploadFile = {
        ...file,
        status: UploadStatus.PREPARING_UPLOAD,
        progress: 0,
        errorMessage: undefined,
      };
      await engine.storage.setItem(draft.id, draft);

      try {
        const success = await processFileUpload(draft);
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

    const { aborted, summary } = await runBatch(failedFiles, {
      batchInfo: createInitialBatchInfo(failedFiles.length, failedFiles.length),
    });

    if (aborted) {
      return {
        success: false,
        message: "批量重试已取消",
        retriedCount: 0,
      };
    }

    await finalizeBatch(summary, failedFiles.length);

    // T-14：跳过的记录在文案里单独说一句，避免用户把「已删除」误读成「又失败了」。
    const skippedText =
      summary.skippedCount > 0 ? `, ${summary.skippedCount}个已跳过` : "";

    return {
      success: summary.failedCount === 0,
      message: `重试完成: ${summary.successCount}个成功, ${summary.failedCount}个失败${skippedText}`,
      retriedCount: failedFiles.length,
    };
  }, [isNetworkOffline, engine, runBatch, finalizeBatch]);

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
      cancelUploadFile,
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
      cancelUploadFile,
      retryUploadFile,
      retryAllFailedFiles,
      forceCleanupUI,
      pendingCleanupCount,
    ]
  );
}
