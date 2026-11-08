import { BatchInfoDisplay, FileUploadActions } from "./components";
import React, { lazy, Suspense, useCallback, useEffect, useRef } from "react";
import {
  useBatchUploader,
  useFileOperations,
  useFileProcessor,
  useNetworkDetection,
} from "./hooks";

import { recoverUploadQueueOnMount } from "./services/uploadStorage";
import { useUploadStore } from "./store/upload";
import { useUploadEngine } from "./context/UploadEngineContext";
import { UploadProvider } from "./context/UploadContext";
import { useUploadContext } from "./context/useUploadContext";
import { ZustandFileUploadProps } from "./types/upload";
import { useShallow } from "zustand/react/shallow";
import { ErrorBoundary } from "../../ui/ErrorBoundary";

// VU-64：重组件按路由/功能拆包，首屏主 JS 不再含 Table / 存储统计抽屉逻辑。
// 二者均为默认导出，可直接 React.lazy；用法处各包一层 <Suspense> 提供降级。
const LazyFileTable = lazy(() => import("./components/FileTable"));
const LazyStorageStatsDrawer = lazy(() =>
  import("./components/StorageStatsDrawer")
);

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
  // VU-42：uploadAll 身份已稳定，渲染期直接同步到 ref 即可；不再挂一个
  // 「依赖恒变、每次渲染都执行」的 useEffect（原 VU-42 主症状）。
  // VU-42：uploadAll 身份已稳定。VU-64：ref 镜像改在 effect 内更新
  // （render 期写 ref 会触发 react-hooks/refs）；本 effect 注册在恢复 effect 之前，
  // 故异步恢复读取时 ref 已是最新。
  const uploadAllRef = useRef(batchUploader.uploadAll);
  useEffect(() => {
    uploadAllRef.current = batchUploader.uploadAll;
  });
  const fileOperations = useFileOperations(batchUploader);
  const { handleFileChange } = useFileProcessor({
    uploadAll: batchUploader.uploadAll,
  });

  const uploadConfig = useUploadContext();
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
      // VU-51：UploadContext 已把数组按内容签名规范化成稳定引用，
      // 这里不再做 join("|") → split("|") 的无意义往返。
      allowedFileTypes: uploadConfig.allowedFileTypes,
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
    uploadConfig.allowedFileTypes,
    uploadConfig.maxFiles,
    uploadConfig.debug,
  ]);

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
      // VU-39：一次 IDB 快照内完成「中断恢复」+「历史 QUEUED 治理」，
      // 内部把彼此独立的写入用 Promise.all 并发落库，并返回最终有序快照。
      // 旧链路的 3 次 iterate（恢复读 / 治理读 / refreshFiles 读）收敛为 1 次。
      const { files, summary: recovery } = await recoverUploadQueueOnMount(
        engine.storage
      );
      if (disposed) return;

      // 用已知快照刷新 store：不再为了「确认自己刚写进去的内容」再读一遍全表。
      await refreshFiles(files);

      // 同步判断已在唯一的异步 IO 之后立即执行，其后只剩纯内存的消息派发。
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

  const triggerFileInput = useCallback(() => {
    inputRef.current?.click();
  }, []);

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
      <Suspense fallback={null}>
        <LazyFileTable
          fileOperations={fileOperations}
          pauseUploadFile={batchUploader.pauseUploadFile}
          resumeUploadFile={batchUploader.resumeUploadFile}
        />
      </Suspense>
      {uploadConfig.uiMode !== "simple" && (
        <Suspense fallback={null}>
          <LazyStorageStatsDrawer />
        </Suspense>
      )}
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
