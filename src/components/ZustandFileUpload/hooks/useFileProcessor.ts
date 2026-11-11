import type { ChangeEvent } from "react";
import { useEffect, useRef } from "react";

import { useEffectiveUploadConfig } from "./useEffectiveConfig";
import { useUploadStore } from "../store/upload";
import { ProcessingStats, UploadFile, UploadStatus } from "../types/upload";
import { DEFAULT_AUTO_UPLOAD_DELAY_MS } from "../types/upload";

/**
 * 自动上传合并窗口的取值保护。
 *
 * 这个值直接喂给 `setTimeout`，所以脏输入必须有明确行为：
 * - 负数 / NaN / Infinity → 回落默认 120ms。`setTimeout` 收到负数或 NaN 会当 0
 *   立即触发，收到 Infinity 则**永不触发** —— 后者等于「自动上传静默失效」，最糟；
 * - 上限 5000ms：再大已不是「合并窗口」而是「延迟启动」，几乎必然是配置写错。
 */
const resolveAutoUploadDelay = (delay?: number): number => {
  if (typeof delay !== "number" || !Number.isFinite(delay) || delay < 0) {
    return DEFAULT_AUTO_UPLOAD_DELAY_MS;
  }
  return Math.min(delay, 5000);
};
import { useUploadEngine } from "../context/UploadEngineContext";
import { useShallow } from "zustand/react/shallow";
import { compileAllowedTypes, isFileTypeAllowed } from "../../../shared/fileType";
import {
  findDangerousFileViolation,
  formatDangerousFileReason,
} from "../../../shared/fileSafety";
import { reconcileIncomingFiles } from "../services/uploadDedupe";
import {
  clearPerfMarks,
  markPerf,
  recordPerfDetail,
} from "../../../shared/perfTrace";
import {
  primeChunkCache,
  type ChunkCacheStatus,
} from "../services/chunkCache";
// VU-25：应用构建下 worker 独立成 asset；库构建由 vite.lib.config.ts 统一重写为
// `?worker&inline`，避免消费方 dev server 把 .pnpm 深层 worker 路径当 SPA fallback 返回 HTML。
import FilePrepareWorker from "../worker/filePrepareWorker.ts?worker";

interface WorkerProgressMessage {
  type: "progress";
  processed: number;
  total: number;
  success: number;
  failed: number;
  oversized: number;
  fileDetails?: {
    id: string;
    fileName: string;
    fileSize: number;
    fileType: string;
    index: number;
    total: number;
    error?: boolean;
    errorMessage?: string;
  };
}

interface WorkerCompleteMessage {
  type: "complete";
  /** 含 fileRef 回传（T3.1）：主线程登记后剥离再持久化 */
  uploadFiles: Array<UploadFile & { fileRef?: File }>;
  stats: ProcessingStats;
  /** T-29：Worker 内部阶段耗时，仅在埋点开启时消费 */
  timings?: {
    boot: number;
    waitForMessage: number;
    hash: number;
  };
}

type WorkerMessage = WorkerProgressMessage | WorkerCompleteMessage;

const createFilePrepareWorker = () => new FilePrepareWorker();

interface UseFileProcessorOptions {
  uploadAll: () => Promise<boolean>;
}

export function useFileProcessor({ uploadAll }: UseFileProcessorOptions) {
  const {
    existingFiles,
    isNetworkOffline,
    chunkSize,
    refreshFiles,
    setProcessProgress,
    setLoading,
    setCost,
    setFileTimings,
    getMessageApi,
  } = useUploadStore(
    useShallow((state) => ({
      existingFiles: state.files,
      isNetworkOffline: state.isNetworkOffline,
      chunkSize: state.chunkSize,
      refreshFiles: state.refreshFiles,
      setProcessProgress: state.setProcessProgress,
      setLoading: state.setLoading,
      setCost: state.setCost,
      setFileTimings: state.setFileTimings,
      getMessageApi: state.getMessageApi,
    }))
  );
  const uploadConfig = useEffectiveUploadConfig();
  const messageApi = getMessageApi();
  const engine = useUploadEngine();

  const prepareWorkerRef = useRef<Worker | null>(null);
  // 预处理完成后的自动上传定时器：ref 持有，卸载时清理，避免离心上传
  const autoUploadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // VU-17：组件是否已卸载，卸载后跳过 setState / 提示，避免离心写 store
  const disposedRef = useRef(false);
  // VU-17：缓存预处理 Promise 的 settle 句柄，卸载时显式 reject，
  // 否则 worker 被 terminate 后 Promise 永不 settle，loading 态卡死
  const pendingPromiseRef = useRef<{
    resolve: () => void;
    reject: (reason?: unknown) => void;
  } | null>(null);

  useEffect(() => {
    // T-34：StrictMode 会 mount → cleanup → mount 并复用同一份 ref；
    // 若不在 setup 复位，cleanup 留下的 true 会让第二次挂载永久「已卸载」。
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      if (autoUploadTimerRef.current !== null) {
        clearTimeout(autoUploadTimerRef.current);
        autoUploadTimerRef.current = null;
      }
      const worker = prepareWorkerRef.current;
      if (worker) {
        worker.terminate();
        prepareWorkerRef.current = null;
      }
      if (pendingPromiseRef.current) {
        pendingPromiseRef.current.reject(
          new DOMException("组件卸载，文件预处理中断", "AbortError")
        );
        pendingPromiseRef.current = null;
      }
    };
  }, []);

  const validateFiles = (
    files: File[]
  ): { validFiles: File[]; errors: string[] } => {
    const validFiles: File[] = [];
    const errors: string[] = [];

    // P2-3：maxFiles 约束的是「列表内文件总数」，不是单次选择的文件数。
    // 只比较本次 files.length 时，多次少量选择即可无限绕过限制。
    const existingCount = existingFiles.length;
    if (existingCount + files.length > uploadConfig.maxFiles) {
      errors.push(
        existingCount > 0
          ? `最多只能选择 ${uploadConfig.maxFiles} 个文件（当前已有 ${existingCount} 个）`
          : `最多只能选择 ${uploadConfig.maxFiles} 个文件`
      );
      return { validFiles: [], errors };
    }

    // VU-37：白名单一次编译（toLowerCase / 分类提出循环），循环内 O(1) 匹配。
    const allowedTypes = compileAllowedTypes(uploadConfig.allowedFileTypes);

    files.forEach((file) => {
      // E2E-R2：危险类型用与服务端 /merge 相同的清单，在选择阶段直接拦截，
      // 不再「传完所有分片才拿到 415」。这一条优先于白名单，避免被白名单误放行。
      const dangerous = findDangerousFileViolation(file);
      if (dangerous) {
        errors.push(
          `文件 "${file.name}" ${formatDangerousFileReason(dangerous)}`
        );
        return;
      }

      // D-01 决策：不支持空文件。此前前端放行 0 字节文件（chunkCount = 0），
      // 而服务端 /merge 要求 total 为正整数，必然 400 且文案对用户不可执行；
      // 在选文件阶段直接拒绝，避免「分片全部跳过、卡在合并阶段失败」。
      if (file.size === 0) {
        errors.push(`文件 "${file.name}" 为空文件，不支持上传`);
        return;
      }

      if (file.size > uploadConfig.maxFileSize) {
        errors.push(
          `文件 "${file.name}" 大小超过限制 (${Math.round(
            uploadConfig.maxFileSize / 1024 / 1024
          )}MB)`
        );
        return;
      }

      if (!isFileTypeAllowed(file, allowedTypes)) {
        errors.push(`文件 "${file.name}" 类型不被允许`);
        return;
      }

      if (uploadConfig.customFileValidator) {
        const validation = uploadConfig.customFileValidator(file);
        if (!validation.valid) {
          errors.push(validation.message || `文件 "${file.name}" 验证失败`);
          return;
        }
      }

      validFiles.push(file);
    });

    return { validFiles, errors };
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;

    // T-29：首字节归因的起点。每次选文件先清掉上一轮的 mark。
    clearPerfMarks();
    markPerf("change:enter");

    const files = Array.from(e.target.files);
    e.target.value = "";

    if (isNetworkOffline) {
      messageApi.error("网络已断开，无法上传文件");
      return;
    }

    const { validFiles, errors } = validateFiles(files);
    markPerf("change:validated");

    if (errors.length > 0) {
      errors.forEach((error) => messageApi.error(error));
      if (validFiles.length === 0) return;
    }

    if (validFiles.length === 0) {
      messageApi.warning("没有有效的文件可以上传");
      return;
    }

    setFileTimings({});

    setLoading(true);
    const startTime = Date.now();
    // T-34：本次选择的 settle 句柄，用于 finally 只清自己的 ref，
    // 避免旧 handler 收尾时把重入后的新句柄误清空。
    let currentSettle: {
      resolve: () => void;
      reject: (reason?: unknown) => void;
    } | null = null;

    const existingWorker = prepareWorkerRef.current;
    if (existingWorker) {
      // T-34：重入时先 reject 旧 Promise，否则 worker 被 terminate 后
      // await 永不 settle（loading 卡死），旧结果还可能被写回列表。
      const pending = pendingPromiseRef.current;
      if (pending) {
        pending.reject(
          new DOMException("新的文件选择已开始，旧预处理中断", "AbortError")
        );
        pendingPromiseRef.current = null;
        existingWorker.onmessage = null;
        existingWorker.onerror = null;
      }
      existingWorker.terminate();
      prepareWorkerRef.current = null;
    }

    const worker = createFilePrepareWorker();
    prepareWorkerRef.current = worker;
    markPerf("prepare:worker-created");
    let firstProgressMarked = false;

    try {
      await new Promise<void>((resolve, reject) => {
        currentSettle = { resolve, reject };
        pendingPromiseRef.current = currentSettle;
        // T-34：卸载后 IIFE 仍可能从 await 处继续执行（Promise 被 reject
        // 不会中止已启动的 async 函数），每个恢复点都要判活。
        const abortIfDisposed = (): boolean => {
          if (!disposedRef.current) return false;
          reject(new DOMException("组件已卸载，文件预处理中断", "AbortError"));
          return true;
        };
        worker.onerror = (event) => {
          reject(new Error(event.message || "文件预处理失败"));
        };

        worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
          void (async () => {
            if (abortIfDisposed()) return;
            const data = event.data;

            if (data.type === "progress") {
              if (!firstProgressMarked) {
                firstProgressMarked = true;
                markPerf("prepare:first-progress");
              }
              setProcessProgress({
                processed: data.processed,
                total: data.total,
                success: data.success,
                failed: data.failed,
                oversized: data.oversized,
              });

              // VU-17：以 id（而非文件名）作计时键，避免同名文件互相覆盖
              if (data.fileDetails && data.fileDetails.id) {
                const fileId = data.fileDetails.id;
                const processingTime = Date.now() - startTime;
                setFileTimings((prev: Record<string, number>) => ({
                  ...prev,
                  [fileId]: processingTime,
                }));
              }
              return;
            }

            if (data.type !== "complete") {
              return;
            }

            markPerf("prepare:complete");
            // T-29：Worker 内部耗时（脚本加载/等待/哈希）只有它自己知道，
            // 挂到明细包里供归因脚本读取；未开启埋点时该函数直接返回。
            if (data.timings) {
              recordPerfDetail("prepareWorker", { ...data.timings });
            }

            setProcessProgress(null);
            setLoading(false);

            const endTime = Date.now();
            const cost = endTime - startTime;
            setCost(cost);

            // VU-19：按内容指纹（hash+size+lastModified+fileName）去重；
            // E2E-02：若命中「刷新后残留的中断记录」，则复用原记录 id 与
            // chunkSize 重新绑定文件引用，保证服务端分片键跨会话稳定。
            const {
              newItems: newFiles,
              rebindItems,
              skipped,
            } = reconcileIncomingFiles(
              engine.store.getState().files,
              data.uploadFiles
            );

            if (newFiles.length === 0 && rebindItems.length === 0) {
              if (skipped > 0) {
                messageApi.info(`已跳过 ${skipped} 个已在队列中的文件`);
              }
              resolve();
              return;
            }

            // VU-43：N 条彼此独立的 IDB 写入并发执行，不再逐个串行 await。
            // fileRef 注册是同步内存操作，放在同一批任务里保证顺序无关。
            const chunkCacheOptions = {
              instanceId: engine.instanceId,
              maxFileSize: uploadConfig.chunkCacheMaxFileSize,
            };
            // 同一批选择只提示一次同类降级，避免多文件时刷屏。
            const notifiedCacheIssues = new Set<ChunkCacheStatus>();
            const notifyCacheIssue = (status: ChunkCacheStatus) => {
              if (status === "ready" || notifiedCacheIssues.has(status)) {
                return;
              }
              notifiedCacheIssues.add(status);
              if (status === "skipped") {
                const limit = chunkCacheOptions.maxFileSize;
                const limitText =
                  limit && Number.isFinite(limit) && limit > 0
                    ? `${Math.round(limit / 1024 / 1024)}MB`
                    : "配置";
                messageApi.warning(
                  `部分文件待缓存分片超过${limitText}上限，未启用刷新续传缓存，刷新后需重新选择文件`
                );
              } else if (status === "insufficient-space") {
                messageApi.warning(
                  "浏览器可用空间不足，未启用刷新续传缓存，刷新后需重新选择文件"
                );
              } else {
                messageApi.warning(
                  "浏览器存储不可用（如隐私模式）或写入失败，刷新后需重新选择文件继续上传"
                );
              }
            };
            /**
             * 方案 A：选文件即预热分片缓存（全部待传分片）。
             * 不阻塞选择流程；也不阻塞上传启动（T-05）：预热只决定「刷新后能否
             * 零点击续传」，上传字节在会话内来自 fileRef，两者互不依赖。
             * 因此这里 fire-and-forget，processFileUpload 只是幂等地接上同一个 Promise。
             */
            const primeCache = (file: UploadFile, fileRef?: File) => {
              if (!fileRef) {
                return;
              }
              void primeChunkCache(file, fileRef, chunkCacheOptions)
                .then(notifyCacheIssue)
                .catch(() => undefined);
            };

            await Promise.all([
              ...newFiles.map(async (file) => {
                // T3.1：fileRef 仅入主线程注册表，剥离后再持久化；
                // 文件字节由分片缓存（方案 A）持久化，刷新后可重建。
                const { fileRef, ...persistable } = file;
                if (fileRef) {
                  engine.fileRegistry.registerFileRef(file.id, fileRef);
                }
                await engine.storage.setItem(file.id, persistable);
                primeCache(persistable, fileRef);
              }),
              ...rebindItems.map(async ({ existing: record, incoming }) => {
                const merged: UploadFile = {
                  ...incoming,
                  // 复用既有队列 id，服务端分片键随之保持稳定
                  id: record.id,
                  hash: record.hash ?? incoming.hash,
                  hashMode: record.hashMode ?? incoming.hashMode,
                  // 关键：保留既有 chunkSize/chunkCount，不按当前 RTT 重算
                  chunkSize: record.chunkSize || incoming.chunkSize,
                  chunkCount: record.chunkCount || incoming.chunkCount,
                  status: UploadStatus.QUEUED,
                  progress: 0,
                  createdAt: record.createdAt ?? incoming.createdAt,
                  order: record.order ?? incoming.order,
                  errorMessage: undefined,
                  awaitingReselect: undefined,
                };
                if (incoming.fileRef) {
                  engine.fileRegistry.registerFileRef(
                    record.id,
                    incoming.fileRef
                  );
                }
                const persistable: UploadFile = { ...merged };
                // fileRef 仅保留在内存注册表中，不写入 IndexedDB
                delete persistable.fileRef;
                await engine.storage.setItem(record.id, persistable);
                // 重选绑定后按既有 chunkSize/chunkCount 重新预热缓存
                primeCache(persistable, incoming.fileRef);
              }),
            ]);

            if (abortIfDisposed()) return;
            await refreshFiles();
            if (abortIfDisposed()) return;
            markPerf("queue:persisted");

            const resultMessage = `处理完成: ${data.stats.success}个成功, ${
              data.stats.failed
            }个失败${
              data.stats.oversized > 0 ? `, ${data.stats.oversized}个超过大小限制` : ""
            }`;
            messageApi.success(resultMessage);
            if (rebindItems.length > 0) {
              messageApi.info(
                `已重新绑定 ${rebindItems.length} 个中断文件，将从断点继续上传`
              );
            }
            if (skipped > 0) {
              messageApi.info(`已跳过 ${skipped} 个已在队列中的文件`);
            }

            if (abortIfDisposed()) return;
            if (
              uploadConfig.autoUpload &&
              newFiles.length + rebindItems.length > 0 &&
              !isNetworkOffline
            ) {
              // 同一时间只保留一个待执行自动上传；卸载时由 cleanup 统一清理
              if (autoUploadTimerRef.current !== null) {
                clearTimeout(autoUploadTimerRef.current);
              }
              autoUploadTimerRef.current = setTimeout(() => {
                autoUploadTimerRef.current = null;
                // 卸载可能发生在 timer 排队之后：不判活就会发起离心上传
                if (disposedRef.current) return;
                markPerf("autoupload:timer-fired");
                void uploadAll();
              }, resolveAutoUploadDelay(uploadConfig.autoUploadDelay));
            }

            resolve();
          })().catch(reject);
        };

        worker.postMessage({
          files: validFiles,
          hashMode: uploadConfig.hashMode,
          // T-18：预处理 Worker 只读 chunkSize（决定分片数与分片键），
          // 其余网络参数由主线程各自消费，不再白传一遍。
          networkParams: { chunkSize },
        });
      });
    } catch (error) {
      setProcessProgress(null);
      setLoading(false);
      // VU-17：卸载导致的中断（AbortError）不再弹错误提示，避免离心副作用
      if (!disposedRef.current && !(error instanceof DOMException && error.name === "AbortError")) {
        messageApi.error(error instanceof Error ? error.message : "文件预处理失败");
      }
    } finally {
      // T-34：只清自己的句柄。旧 handler 因重入被 abort 后收尾时，
      // 新的选择可能已经写入了新的 settle 句柄。
      if (pendingPromiseRef.current === currentSettle) {
        pendingPromiseRef.current = null;
      }
      if (prepareWorkerRef.current === worker) {
        prepareWorkerRef.current = null;
      }
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
  };

  return {
    handleFileChange,
  };
}
