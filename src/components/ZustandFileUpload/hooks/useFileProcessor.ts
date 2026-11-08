import type { ChangeEvent } from "react";
import { useEffect, useRef } from "react";

import { useEffectiveUploadConfig } from "./useEffectiveConfig";
import { useUploadStore } from "../store/upload";
import { ProcessingStats, UploadFile } from "../types/upload";
import { useUploadEngine } from "../context/UploadEngineContext";
import { useShallow } from "zustand/react/shallow";
import { compileAllowedTypes, isFileTypeAllowed } from "../../../shared/fileType";
import { dedupeByContentKey } from "../services/uploadDedupe";
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
    networkType,
    fileConcurrency,
    chunkConcurrency,
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
      networkType: state.networkType,
      fileConcurrency: state.fileConcurrency,
      chunkConcurrency: state.chunkConcurrency,
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

    const files = Array.from(e.target.files);
    e.target.value = "";

    if (isNetworkOffline) {
      messageApi.error("网络已断开，无法上传文件");
      return;
    }

    const { validFiles, errors } = validateFiles(files);

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

    const existingWorker = prepareWorkerRef.current;
    if (existingWorker) {
      existingWorker.terminate();
      prepareWorkerRef.current = null;
    }

    const worker = createFilePrepareWorker();
    prepareWorkerRef.current = worker;

    try {
      await new Promise<void>((resolve, reject) => {
        pendingPromiseRef.current = { resolve, reject };
        worker.onerror = (event) => {
          reject(new Error(event.message || "文件预处理失败"));
        };

        worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
          void (async () => {
            const data = event.data;

            if (data.type === "progress") {
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

            setProcessProgress(null);
            setLoading(false);

            const endTime = Date.now();
            const cost = endTime - startTime;
            setCost(cost);

            // VU-19：按内容指纹（hash+size+lastModified+fileName）去重，
            // 同一物理文件重复选择只保留一条队列记录，不再生成多条。
            const { newItems: newFiles, skipped } = dedupeByContentKey(
              engine.store.getState().files,
              data.uploadFiles
            );

            if (newFiles.length === 0) {
              if (skipped > 0) {
                messageApi.info(`已跳过 ${skipped} 个已在队列中的文件`);
              }
              resolve();
              return;
            }

            // VU-43：N 条彼此独立的 IDB 写入并发执行，不再逐个串行 await。
            // fileRef 注册是同步内存操作，放在同一批任务里保证顺序无关。
            await Promise.all(
              newFiles.map(async (file) => {
                // T3.1：fileRef 仅入主线程注册表，剥离后再持久化，
                // IndexedDB 中不再存放整文件数据（原 buffer 字段已移除）
                const { fileRef, ...persistable } = file;
                if (fileRef) {
                  engine.fileRegistry.registerFileRef(file.id, fileRef);
                }
                await engine.storage.setItem(file.id, persistable);
              })
            );

            await refreshFiles();

            const resultMessage = `处理完成: ${data.stats.success}个成功, ${
              data.stats.failed
            }个失败${
              data.stats.oversized > 0 ? `, ${data.stats.oversized}个超过大小限制` : ""
            }`;
            messageApi.success(resultMessage);
            if (skipped > 0) {
              messageApi.info(`已跳过 ${skipped} 个已在队列中的文件`);
            }

            if (uploadConfig.autoUpload && newFiles.length > 0 && !isNetworkOffline) {
              // 同一时间只保留一个待执行自动上传；卸载时由 cleanup 统一清理
              if (autoUploadTimerRef.current !== null) {
                clearTimeout(autoUploadTimerRef.current);
              }
              autoUploadTimerRef.current = setTimeout(() => {
                autoUploadTimerRef.current = null;
                void uploadAll();
              }, 500);
            }

            resolve();
          })().catch(reject);
        };

        worker.postMessage({
          files: validFiles,
          hashMode: uploadConfig.hashMode,
          networkParams: {
            networkType,
            fileConcurrency,
            chunkConcurrency,
            chunkSize,
          },
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
      pendingPromiseRef.current = null;
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
