import { useCallback, useMemo } from "react";
import { UploadFile } from "../types/upload";
import { useUploadStore } from "../store/upload";
import { useUploadEngine } from "../context/UploadEngineContext";
import type { BatchUploaderActions } from "./useBatchUploader";
import { useShallow } from "zustand/react/shallow";

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

  const handleDeleteFile = useCallback(
    async (id: string): Promise<void> => {
      try {
        await engine.storage.removeItem(id);
        await refreshFiles();
        getMessageApi().success("文件已删除");
      } catch {
        getMessageApi().error("删除文件失败");
      }
    },
    [engine, refreshFiles, getMessageApi]
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
