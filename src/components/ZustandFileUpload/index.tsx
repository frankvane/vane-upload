import {
  BatchInfoDisplay,
  FileTable,
  FileUploadActions,
  StorageStatsDrawer,
} from "./components";
import React, { useEffect, useMemo, useRef } from "react";
import {
  useBatchUploader,
  useFileOperations,
  useFileProcessor,
  useNetworkDetection,
} from "./hooks";

import {
  recoverInterruptedUploadFiles,
} from "./services/uploadStorage";
import { loadAllUploadFiles } from "./services/uploadOrchestrator";
import { useUploadStore } from "./store/upload";
import { useUploadEngine } from "./context/UploadEngineContext";
import { UploadProvider } from "./context/UploadContext";
import { useUploadContext } from "./context/useUploadContext";
import { UploadStatus, ZustandFileUploadProps } from "./types/upload";
import { useShallow } from "zustand/react/shallow";
import { ErrorBoundary } from "../../ui";

const ZustandFileUploadCore: React.FC = () => {
  const { refreshFiles, initSettings, setConfig } = useUploadStore(
    useShallow((state) => ({
      refreshFiles: state.refreshFiles,
      initSettings: state.initSettings,
      setConfig: state.setConfig,
    }))
  );
  const engine = useUploadEngine();
  const batchUploader = useBatchUploader();
  const uploadAllRef = useRef(batchUploader.uploadAll);
  const fileOperations = useFileOperations(batchUploader);
  const { handleFileChange } = useFileProcessor({
    uploadAll: batchUploader.uploadAll,
  });

  const uploadConfig = useUploadContext();
  const allowedFileTypesKey = uploadConfig.allowedFileTypes.join("|");
  const normalizedAllowedFileTypes = useMemo(
    () => (allowedFileTypesKey ? allowedFileTypesKey.split("|") : []),
    [allowedFileTypesKey]
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const hasRecoveredOnceRef = useRef(false);

  useNetworkDetection();

  useEffect(() => {
    setConfig({
      baseURL: uploadConfig.baseURL,
      uploadApi: uploadConfig.uploadApi,
      checkApi: uploadConfig.checkApi,
      mergeApi: uploadConfig.mergeApi,
      chunkSize: uploadConfig.chunkSize,
      fileConcurrency: uploadConfig.fileConcurrency,
      chunkConcurrency: uploadConfig.chunkConcurrency,
      maxRetries: uploadConfig.maxRetries,
      hashMode: uploadConfig.hashMode,
      maxFileSize: uploadConfig.maxFileSize,
      allowedFileTypes: normalizedAllowedFileTypes,
      maxFiles: uploadConfig.maxFiles,
      debug: uploadConfig.debug,
    });
  }, [
    setConfig,
    uploadConfig.baseURL,
    uploadConfig.uploadApi,
    uploadConfig.checkApi,
    uploadConfig.mergeApi,
    uploadConfig.chunkSize,
    uploadConfig.fileConcurrency,
    uploadConfig.chunkConcurrency,
    uploadConfig.maxRetries,
    uploadConfig.hashMode,
    uploadConfig.maxFileSize,
    normalizedAllowedFileTypes,
    uploadConfig.maxFiles,
    uploadConfig.debug,
  ]);

  useEffect(() => {
    uploadAllRef.current = batchUploader.uploadAll;
  }, [batchUploader.uploadAll]);

  useEffect(() => {
    initSettings({
      autoUpload: uploadConfig.autoUpload,
      autoCleanup: uploadConfig.autoCleanup,
      cleanupDelay: uploadConfig.cleanupDelay,
      networkDisplayMode: uploadConfig.networkDisplayMode,
      settingsSource: uploadConfig.settingsSource,
    });

    if (hasRecoveredOnceRef.current) {
      return;
    }
    hasRecoveredOnceRef.current = true;

    let disposed = false;

    const recoverInterruptedUploads = async () => {
      const recovery = await recoverInterruptedUploadFiles(engine.storage);

      // 历史 QUEUED 行治理：QUEUED 不在 interruptedUploadStatuses 内，
      // 恢复逻辑不会触碰；而页面刷新后运行时 File 引用（fileRef）必然丢失，
      // 这类行永远无法自动上传，会一直卡在「排队中」且没有重试入口。
      // 挂载时统一转为 awaitingReselect 的 ERROR 行，给出明确指引。
      const staleQueuedFiles = (await loadAllUploadFiles(engine.storage)).filter(
        (file) =>
          file.status === UploadStatus.QUEUED ||
          file.status === UploadStatus.QUEUED_FOR_UPLOAD
      );
      for (const stale of staleQueuedFiles) {
        await engine.storage.setItem(stale.id, {
          ...stale,
          status: UploadStatus.ERROR,
          progress: 0,
          errorMessage: "页面已刷新，请重新选择文件后上传",
          awaitingReselect: true,
        });
      }

      await refreshFiles();

      if (disposed || recovery.totalInterrupted === 0) {
        return;
      }

      const messageApi = engine.store.getState().getMessageApi();

      if (recovery.recoveredCount > 0) {
        messageApi.info(
          `检测到 ${recovery.recoveredCount} 个中断上传任务，已恢复为待上传`
        );
      }

      if (recovery.missingFileRefCount > 0) {
        messageApi.warning(
          `${recovery.missingFileRefCount} 个文件缓存缺失，需重新选择后上传`
        );
      }

      const shouldAutoResume =
        uploadConfig.autoUpload &&
        !engine.store.getState().isNetworkOffline &&
        recovery.recoveredCount > 0;

      if (shouldAutoResume) {
        messageApi.info("检测到中断上传任务，正在自动继续上传");
        void uploadAllRef.current();
      }
    };

    void recoverInterruptedUploads();

    return () => {
      disposed = true;
    };
  }, [
    engine,
    initSettings,
    refreshFiles,
    uploadConfig.autoUpload,
    uploadConfig.autoCleanup,
    uploadConfig.cleanupDelay,
    uploadConfig.networkDisplayMode,
    uploadConfig.settingsSource,
  ]);

  const triggerFileInput = () => {
    inputRef.current?.click();
  };

  return (
    <div>
      <input
        type="file"
        ref={inputRef}
        onChange={handleFileChange}
        multiple
        style={{ display: "none" }}
      />

      <FileUploadActions
        triggerFileInput={triggerFileInput}
        batchUploader={batchUploader}
        fileOperations={fileOperations}
      />
      {uploadConfig.uiMode !== "simple" && (
        <BatchInfoDisplay batchUploader={batchUploader} />
      )}
      <FileTable
        fileOperations={fileOperations}
        pauseUploadFile={batchUploader.pauseUploadFile}
        resumeUploadFile={batchUploader.resumeUploadFile}
      />
      {uploadConfig.uiMode !== "simple" && <StorageStatsDrawer />}
    </div>
  );
};

const ZustandFileUpload: React.FC<ZustandFileUploadProps> = (props) => {
  return (
    <ErrorBoundary fallbackTitle="上传组件加载失败">
      <UploadProvider {...props}>
        <ZustandFileUploadCore />
      </UploadProvider>
    </ErrorBoundary>
  );
};

export default ZustandFileUpload;
