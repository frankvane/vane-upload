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

  const messageApi = getMessageApi();
  const engine = useUploadEngine();

  const handleDeleteFile = async (id: string): Promise<void> => {
    try {
      await engine.storage.removeItem(id);
      await refreshFiles();
      messageApi.success("文件已删除");
    } catch {
      messageApi.error("删除文件失败");
    }
  };

  const handleRetryUpload = async (file: UploadFile): Promise<void> => {
    setRetryingFiles((prev) => ({ ...prev, [file.id]: true }));

    try {
      const result = await retryUploadFile(file);
      if (result.success) {
        messageApi.success(result.message);
      } else {
        messageApi.error(result.message);
      }
    } finally {
      setRetryingFiles((prev) => {
        const updated = { ...prev };
        delete updated[file.id];
        return updated;
      });
    }
  };

  const handleClearList = async (): Promise<boolean> => {
    try {
      await engine.storage.clear();
      await refreshFiles();
      messageApi.success("文件列表已清空");
      return true;
    } catch {
      messageApi.error("清空文件列表失败");
      return false;
    }
  };

  const handleRetryAllUpload = async (): Promise<{
    success: boolean;
    message: string;
    retriedCount: number;
  }> => {
    setIsRetryingAll(true);

    try {
      const result = await retryAllFailedFiles();

      if (result.success) {
        messageApi.success(result.message);
      } else {
        messageApi.error(result.message);
      }

      return result;
    } finally {
      setIsRetryingAll(false);
    }
  };

  return {
    retryingFiles,
    isRetryingAll,
    handleDeleteFile,
    handleRetryUpload,
    handleClearList,
    handleRetryAllUpload,
  };
}
