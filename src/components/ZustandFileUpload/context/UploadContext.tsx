/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useEffect, useRef } from "react";
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
  const engineRef = useRef<UploadEngine | null>(null);
  if (engineRef.current === null) {
    const storage = createUploadStorage(instanceId);
    const fileRegistry = createFileRegistry();
    const workerPool = createUploadWorkerPool();
    const store = createUploadStore(storage);
    engineRef.current = {
      instanceId: instanceId ?? "default",
      storage,
      fileRegistry,
      workerPool,
      store,
    };
  }
  const engine = engineRef.current;

  useEffect(() => {
    return () => {
      engine.workerPool.dispose();
      engine.fileRegistry.releaseAllFileRefs();
    };
  }, [engine]);

  const value: UploadContextType = {
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
    allowedFileTypes,
    maxFiles,
    autoUpload,
    autoCleanup,
    cleanupDelay,
    networkDisplayMode,
    uiMode,
    settingsSource,
    debug,
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
    withCredentials,
  };

  return (
    <UploadStoreContext.Provider value={engine.store}>
      <UploadEngineContext.Provider value={engine}>
        <UploadContext.Provider value={value}>{children}</UploadContext.Provider>
      </UploadEngineContext.Provider>
    </UploadStoreContext.Provider>
  );
};
