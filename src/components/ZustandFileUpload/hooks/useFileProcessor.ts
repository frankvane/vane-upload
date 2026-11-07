import type { ChangeEvent } from "react";
import { useEffect, useRef } from "react";

import { useEffectiveUploadConfig } from "./useEffectiveConfig";
import { useUploadStore } from "../store/upload";
import { ProcessingStats, UploadFile } from "../types/upload";
import { useUploadEngine } from "../context/UploadEngineContext";
import { useShallow } from "zustand/react/shallow";
// 用 Vite `?worker&inline` 把 worker 源码内联为 Blob，消费方无需再解析外部 worker 资产
// （否则发布后 dev 下 `new URL('...', import.meta.url)` 指向的 .pnpm 深层路径会被 dev server
// 当作 SPA fallback 返回 HTML，导致 worker 加载失败 → “文件预处理失败”）。
import FilePrepareWorker from "../worker/filePrepareWorker.ts?worker&inline";

interface WorkerProgressMessage {
  type: "progress";
  processed: number;
  total: number;
  success: number;
  failed: number;
  oversized: number;
  fileDetails?: {
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

  const fileStartTimesRef = useRef<Record<string, number>>({});
  const prepareWorkerRef = useRef<Worker | null>(null);
  // 预处理完成后的自动上传定时器：ref 持有，卸载时清理，避免离心上传
  const autoUploadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (autoUploadTimerRef.current !== null) {
        clearTimeout(autoUploadTimerRef.current);
        autoUploadTimerRef.current = null;
      }
      const worker = prepareWorkerRef.current;
      if (worker) {
        worker.terminate();
        prepareWorkerRef.current = null;
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

    files.forEach((file) => {
      if (file.size > uploadConfig.maxFileSize) {
        errors.push(
          `文件 "${file.name}" 大小超过限制 (${Math.round(
            uploadConfig.maxFileSize / 1024 / 1024
          )}MB)`
        );
        return;
      }

      if (uploadConfig.allowedFileTypes.length > 0) {
        const fileExtension = file.name.split(".").pop()?.toLowerCase();
        const mimeType = file.type.toLowerCase();

        const isAllowed = uploadConfig.allowedFileTypes.some((type: string) => {
          if (type.startsWith(".")) {
            return fileExtension === type.slice(1).toLowerCase();
          }
          return mimeType.includes(type.toLowerCase());
        });

        if (!isAllowed) {
          errors.push(`文件 "${file.name}" 类型不被允许`);
          return;
        }
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

    fileStartTimesRef.current = {};
    setFileTimings({});

    setLoading(true);
    const startTime = Date.now();

    validFiles.forEach((file) => {
      fileStartTimesRef.current[file.name] = Date.now();
    });

    const existingWorker = prepareWorkerRef.current;
    if (existingWorker) {
      existingWorker.terminate();
      prepareWorkerRef.current = null;
    }

    const worker = createFilePrepareWorker();
    prepareWorkerRef.current = worker;

    try {
      await new Promise<void>((resolve, reject) => {
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

              if (data.fileDetails && data.fileDetails.fileName) {
                const fileName = data.fileDetails.fileName;
                const fileStartTime = fileStartTimesRef.current[fileName] || 0;
                if (fileStartTime > 0) {
                  const processingTime = Date.now() - fileStartTime;
                  setFileTimings((prev: Record<string, number>) => ({
                    ...prev,
                    [fileName]: processingTime,
                  }));
                  delete fileStartTimesRef.current[fileName];
                }
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

            for (const file of data.uploadFiles) {
              // T3.1：fileRef 仅入主线程注册表，剥离后再持久化，
              // IndexedDB 中不再存放整文件数据（原 buffer 字段已移除）
              const { fileRef, ...persistable } = file;
              if (fileRef) {
                engine.fileRegistry.registerFileRef(file.id, fileRef);
              }
              await engine.storage.setItem(file.id, persistable);

              if (!fileStartTimesRef.current[file.fileName] && data.uploadFiles.length > 0) {
                setFileTimings((prev: Record<string, number>) => ({
                  ...prev,
                  [file.fileName]: Math.round(cost / data.uploadFiles.length),
                }));
              }
            }

            await refreshFiles();

            const resultMessage = `处理完成: ${data.stats.success}个成功, ${
              data.stats.failed
            }个失败${
              data.stats.oversized > 0 ? `, ${data.stats.oversized}个超过大小限制` : ""
            }`;
            messageApi.success(resultMessage);

            if (uploadConfig.autoUpload && data.stats.success > 0 && !isNetworkOffline) {
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
      messageApi.error(error instanceof Error ? error.message : "文件预处理失败");
    } finally {
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
