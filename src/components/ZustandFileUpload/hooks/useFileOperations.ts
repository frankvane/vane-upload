import { useCallback, useMemo } from "react";
import { UploadFile } from "../types/upload";
import { useUploadStore } from "../store/upload";
import { useUploadEngine } from "../context/UploadEngineContext";
import type { BatchUploaderActions } from "./useBatchUploader";
import { useShallow } from "zustand/react/shallow";
import { buildChunkKey } from "../../../shared/chunkKey";
import { joinUrl } from "../../../shared/url";
import { resolveAuthHeaders, resolveRequestCredentials } from "../utils/auth";
import { useEffectiveUploadConfig } from "./useEffectiveConfig";
import {
  clearFileChunkCache,
  clearInstanceChunkCache,
} from "../services/chunkCache";

const DEFAULT_ABORT_API = "/api/file/abort";

/** 由 uploadApi 推导 abort 接口（`/…/upload` → `/…/abort`），无法推导时回落默认路径。 */
const resolveAbortApi = (uploadApi: string): string =>
  /\/upload\/?$/.test(uploadApi)
    ? uploadApi.replace(/\/upload\/?$/, "/abort")
    : DEFAULT_ABORT_API;

/**
 * E2E-03：删除文件时清理服务端已落的分片。
 * 暂停态没有存活 Worker，删除后这些分片永远不会被合并成文件，
 * 必须由客户端显式通知服务端清理，否则会变成永久孤儿分片。
 * best-effort：失败不阻塞本地删除，分片最终由 janitor 兜底。
 */
const abortServerChunks = async (
  file: UploadFile,
  config: ReturnType<typeof useEffectiveUploadConfig>
): Promise<void> => {
  const fileId = buildChunkKey(
    file.hash,
    file.fileSize,
    file.chunkSize ?? config.chunkSize
  );
  if (!fileId) {
    return;
  }

  const authHeaders = await resolveAuthHeaders(config);
  await fetch(joinUrl(config.baseURL, resolveAbortApi(config.uploadApi)), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    credentials: resolveRequestCredentials(config.withCredentials),
    body: JSON.stringify({ file_id: fileId }),
  });
};

type RetryBatchUploaderActions = Pick<
  BatchUploaderActions,
  "retryUploadFile" | "retryAllFailedFiles"
>;

export interface FileOperationsActions {
  retryingFiles: Record<string, boolean>;
  isRetryingAll: boolean;
  handleDeleteFile: (id: string) => Promise<void>;
  handleRetryUpload: (file: UploadFile) => Promise<void>;
  handleClearList: () => Promise<boolean>;
  handleRetryAllUpload: () => Promise<{
    success: boolean;
    message: string;
    retriedCount: number;
  }>;
}

/** VU-42：动作与返回对象身份稳定，避免下游表格行/按钮被无意义重渲染击穿。 */
export function useFileOperations(
  batchUploader: RetryBatchUploaderActions
): FileOperationsActions {
  const {
    refreshFiles,
    getMessageApi,
    retryingFiles,
    isRetryingAll,
    setRetryingFiles,
    setIsRetryingAll,
  } = useUploadStore(
    useShallow((state) => ({
      refreshFiles: state.refreshFiles,
      getMessageApi: state.getMessageApi,
      retryingFiles: state.retryingFiles,
      isRetryingAll: state.isRetryingAll,
      setRetryingFiles: state.setRetryingFiles,
      setIsRetryingAll: state.setIsRetryingAll,
    }))
  );
  const { retryUploadFile, retryAllFailedFiles } = batchUploader;

  const engine = useUploadEngine();
  const uploadConfig = useEffectiveUploadConfig();

  const handleDeleteFile = useCallback(
    async (id: string): Promise<void> => {
      try {
        const { files } = engine.store.getState();
        const file = files.find((item) => item.id === id);

        // E2E-03：删除即中止。先通知 Worker 取消在途分片请求——只删 IndexedDB
        // 记录无法阻止 worker 继续发分片，任务收尾还会把记录写回导致「复活」。
        engine.workerPool.cancelUploadTask(id);
        engine.fileRegistry.releaseFileRef(id);
        // 方案 A：删除记录即清理分片缓存，并作废在途预热，避免删后被写回。
        void clearFileChunkCache(engine.instanceId, id);

        await engine.storage.removeItem(id);

        // 暂停态无存活 Worker：服务端已落的分片不会再有合并机会，需主动清理。
        if (file?.hash) {
          void abortServerChunks(file, uploadConfig).catch(() => undefined);
        }

        await refreshFiles();
        getMessageApi().success("文件已删除");
      } catch {
        getMessageApi().error("删除文件失败");
      }
    },
    [engine, refreshFiles, getMessageApi, uploadConfig]
  );

  const handleRetryUpload = useCallback(
    async (file: UploadFile): Promise<void> => {
      setRetryingFiles((prev) => ({ ...prev, [file.id]: true }));

      try {
        const result = await retryUploadFile(file);
        if (result.success) {
          getMessageApi().success(result.message);
        } else {
          getMessageApi().error(result.message);
        }
      } finally {
        setRetryingFiles((prev) => {
          const updated = { ...prev };
          delete updated[file.id];
          return updated;
        });
      }
    },
    [setRetryingFiles, retryUploadFile, getMessageApi]
  );

  const handleClearList = useCallback(async (): Promise<boolean> => {
    try {
      await engine.storage.clear();
      // 清空列表 = 放弃所有续传：同步清空该实例的全部分片缓存。
      await clearInstanceChunkCache(engine.instanceId);
      await refreshFiles();
      getMessageApi().success("文件列表已清空");
      return true;
    } catch {
      getMessageApi().error("清空文件列表失败");
      return false;
    }
  }, [engine, refreshFiles, getMessageApi]);

  const handleRetryAllUpload = useCallback(async (): Promise<{
    success: boolean;
    message: string;
    retriedCount: number;
  }> => {
    setIsRetryingAll(true);

    try {
      const result = await retryAllFailedFiles();

      if (result.success) {
        getMessageApi().success(result.message);
      } else {
        getMessageApi().error(result.message);
      }

      return result;
    } finally {
      setIsRetryingAll(false);
    }
  }, [setIsRetryingAll, retryAllFailedFiles, getMessageApi]);

  return useMemo(
    () => ({
      retryingFiles,
      isRetryingAll,
      handleDeleteFile,
      handleRetryUpload,
      handleClearList,
      handleRetryAllUpload,
    }),
    [
      retryingFiles,
      isRetryingAll,
      handleDeleteFile,
      handleRetryUpload,
      handleClearList,
      handleRetryAllUpload,
    ]
  );
}
