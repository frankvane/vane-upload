import React, { createContext, useEffect, useMemo } from "react";
import {
  UploadConfig,
  UploadSettingsSource,
  UploadUIMode,
  UploadAuthConfig,
  UploadColumnKey,
  ZustandFileUploadProps,
} from "../types/upload";
import { API_BASE_URL, API_PATHS } from "../../../config/api";
import { createUploadStorage } from "../services/uploadStorageInstance";
import { createFileRegistry } from "../services/fileRegistry";
import { createUploadWorkerPool } from "../services/uploadWorkerBridge";
import { createUploadStore, UploadStoreContext } from "../store/upload";
import { UploadEngine, UploadEngineContext } from "./UploadEngineContext";

const DEFAULT_CONFIG: UploadConfig = {
  baseURL: API_BASE_URL,
  uploadApi: API_PATHS.file.upload,
  checkApi: API_PATHS.file.instant,
  mergeApi: API_PATHS.file.merge,
  chunkSize: 1024 * 1024,
  fileConcurrency: 2,
  chunkConcurrency: 2,
  maxRetries: 3,
  hashMode: "full",
  maxFileSize: 100 * 1024 * 1024,
  allowedFileTypes: [],
  maxFiles: 100,
};

export interface UploadContextType extends UploadConfig, UploadAuthConfig {
  onUploadStart?: ZustandFileUploadProps["onUploadStart"];
  onUploadProgress?: ZustandFileUploadProps["onUploadProgress"];
  onUploadProgressDetail?: ZustandFileUploadProps["onUploadProgressDetail"];
  onUploadComplete?: ZustandFileUploadProps["onUploadComplete"];
  onUploadError?: ZustandFileUploadProps["onUploadError"];
  onBatchComplete?: ZustandFileUploadProps["onBatchComplete"];
  customFileValidator?: ZustandFileUploadProps["customFileValidator"];
  customUploadHandler?: ZustandFileUploadProps["customUploadHandler"];
  autoUpload: boolean;
  autoCleanup: boolean;
  cleanupDelay: number;
  networkDisplayMode: "tooltip" | "direct";
  uiMode: UploadUIMode;
  settingsSource: UploadSettingsSource;
  /** 上传表格可见列（key 数组）；缺省显示全部内置列 */
  visibleColumns?: UploadColumnKey[];
}

export const UploadContext = createContext<UploadContextType | undefined>(
  undefined
);

interface UploadProviderProps extends ZustandFileUploadProps {
  children: React.ReactNode;
}

export const UploadProvider: React.FC<UploadProviderProps> = ({
  children,
  baseURL = DEFAULT_CONFIG.baseURL,
  uploadApi = DEFAULT_CONFIG.uploadApi,
  checkApi = DEFAULT_CONFIG.checkApi,
  mergeApi = DEFAULT_CONFIG.mergeApi,
  chunkSize = DEFAULT_CONFIG.chunkSize,
  fileConcurrency = DEFAULT_CONFIG.fileConcurrency,
  chunkConcurrency = DEFAULT_CONFIG.chunkConcurrency,
  maxRetries = DEFAULT_CONFIG.maxRetries,
  hashMode = DEFAULT_CONFIG.hashMode,
  maxFileSize = DEFAULT_CONFIG.maxFileSize,
  allowedFileTypes = DEFAULT_CONFIG.allowedFileTypes,
  maxFiles = DEFAULT_CONFIG.maxFiles,
  autoUpload = true,
  autoCleanup = true,
  cleanupDelay = 10,
  networkDisplayMode = "tooltip",
  uiMode = "full",
  settingsSource = "localStorage",
  debug = false,
  visibleColumns,
  onUploadStart,
  onUploadProgress,
  onUploadProgressDetail,
  onUploadComplete,
  onUploadError,
  onBatchComplete,
  customFileValidator,
  customUploadHandler,
  authToken,
  getAuthToken,
  getAuthHeaders,
  authScheme,
  withCredentials = false,
  instanceId,
}) => {
  // T3.2 单例治理：每个 <FileUpload> 实例持有一套独立的引擎资源
  // （store / storage / fileRegistry / workerPool），经 context 下发，
  // 实现多实例互不串数据；卸载时仅释放自身资源。
  //
  // VU-16：改为 useMemo(instanceId)，instanceId 变化时重建引擎；下方 effect 的
  // cleanup 会在切换前释放旧引擎，解决「instanceId 变更不生效 + 旧资源泄漏」。
  // 工厂本身只创建轻量对象（worker 是懒创建），不会在 render 期产生外部副作用。
  const engine = useMemo<UploadEngine>(() => {
    const storage = createUploadStorage(instanceId);
    const fileRegistry = createFileRegistry();
    const workerPool = createUploadWorkerPool();
    const store = createUploadStore(storage);
    return {
      instanceId: instanceId ?? "default",
      storage,
      fileRegistry,
      workerPool,
      store,
    };
  }, [instanceId]);

  useEffect(() => {
    return () => {
      engine.workerPool.dispose();
      engine.fileRegistry.releaseAllFileRefs();
    };
  }, [engine]);

  // VU-45：非原始 props（数组）按内容签名规范化成稳定引用，再参与 value 的
  // useMemo 依赖。避免宿主传入内容相同的新数组时击穿整棵子树。
  const allowedTypesKey = allowedFileTypes.join("|");
  const visibleColumnsKey = visibleColumns?.join("|");
  const stableAllowedFileTypes = useMemo(
    () => (allowedTypesKey ? allowedTypesKey.split("|") : []),
    [allowedTypesKey]
  );
  const stableVisibleColumns = useMemo<UploadColumnKey[] | undefined>(() => {
    if (visibleColumnsKey === undefined) return undefined;
    return visibleColumnsKey
      ? (visibleColumnsKey.split("|") as UploadColumnKey[])
      : [];
  }, [visibleColumnsKey]);

  // VU-16 / VU-45：context value 只在这些原语 / 稳定引用变化时才换身份，
  // 宿主无关重渲染（如 notify toast）不再让所有 Consumer 重渲染。
  const value = useMemo<UploadContextType>(
    () => ({
      baseURL,
      uploadApi,
      checkApi,
      mergeApi,
      chunkSize,
      fileConcurrency,
      chunkConcurrency,
      maxRetries,
      hashMode,
      maxFileSize,
      allowedFileTypes: stableAllowedFileTypes,
      maxFiles,
      autoUpload,
      autoCleanup,
      cleanupDelay,
      networkDisplayMode,
      uiMode,
      settingsSource,
      debug,
      visibleColumns: stableVisibleColumns,
      onUploadStart,
      onUploadProgress,
      onUploadProgressDetail,
      onUploadComplete,
      onUploadError,
      onBatchComplete,
      customFileValidator,
      customUploadHandler,
      authToken,
      getAuthToken,
      getAuthHeaders,
      authScheme,
      withCredentials,
    }),
    [
      baseURL,
      uploadApi,
      checkApi,
      mergeApi,
      chunkSize,
      fileConcurrency,
      chunkConcurrency,
      maxRetries,
      hashMode,
      maxFileSize,
      stableAllowedFileTypes,
      maxFiles,
      autoUpload,
      autoCleanup,
      cleanupDelay,
      networkDisplayMode,
      uiMode,
      settingsSource,
      debug,
      stableVisibleColumns,
      onUploadStart,
      onUploadProgress,
      onUploadProgressDetail,
      onUploadComplete,
      onUploadError,
      onBatchComplete,
      customFileValidator,
      customUploadHandler,
      authToken,
      getAuthToken,
      getAuthHeaders,
      authScheme,
      withCredentials,
    ]
  );

  return (
    <UploadStoreContext.Provider value={engine.store}>
      <UploadEngineContext.Provider value={engine}>
        <UploadContext.Provider value={value}>{children}</UploadContext.Provider>
      </UploadEngineContext.Provider>
    </UploadStoreContext.Provider>
  );
};
