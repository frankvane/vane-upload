import { useUploadContext } from "../context/useUploadContext";
import { useUploadStore } from "../store/upload";
import type { UploadColumnKey } from "../types/upload";
import { useMemo } from "react";

/**
 * 获取有效的上传配置
 * 优先级：Store 中的用户修改值 > Context 中的 Props 初始值
 */
export const useEffectiveUploadConfig = () => {
  const contextConfig = useUploadContext();

  // 直接获取 store 中的各个值，避免选择器缓存问题
  const autoUpload = useUploadStore((state) => state.autoUpload);
  const autoCleanup = useUploadStore((state) => state.autoCleanup);
  const cleanupDelay = useUploadStore((state) => state.cleanupDelay);
  const networkDisplayMode = useUploadStore((state) => state.networkDisplayMode);
  const chunkSize = useUploadStore((state) => state.chunkSize);
  const fileConcurrency = useUploadStore((state) => state.fileConcurrency);
  const chunkConcurrency = useUploadStore((state) => state.chunkConcurrency);
  const maxRetries = useUploadStore((state) => state.maxRetries);

  // 使用 useMemo 缓存合并后的配置对象
  const storeConfig = useMemo(() => ({
    autoUpload,
    autoCleanup,
    cleanupDelay,
    networkDisplayMode,
    chunkSize,
    fileConcurrency,
    chunkConcurrency,
    maxRetries,
  }), [autoUpload, autoCleanup, cleanupDelay, networkDisplayMode, chunkSize, fileConcurrency, chunkConcurrency, maxRetries]);

  // VU-45：非原始 props 用 join 签名派生稳定数组，最终配置的依赖里不再
  // 出现数组对象引用。宿主传入内容相同的新数组时，配置身份保持不变。
  const allowedTypesKey = contextConfig.allowedFileTypes.join("|");
  const visibleColumnsKey = contextConfig.visibleColumns?.join("|");
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

  // 使用 useMemo 缓存合并后的最终配置对象
  return useMemo(() => ({
    // API 配置（通常不允许运行时修改）
    baseURL: contextConfig.baseURL,
    uploadApi: contextConfig.uploadApi,
    checkApi: contextConfig.checkApi,
    mergeApi: contextConfig.mergeApi,

    // 文件限制配置（通常不允许运行时修改）
    maxFileSize: contextConfig.maxFileSize,
    allowedFileTypes: stableAllowedFileTypes,
    maxFiles: contextConfig.maxFiles,
    chunkCacheMaxFileSize: contextConfig.chunkCacheMaxFileSize,

    // 网络参数配置（可能允许运行时修改，但通常使用 Context 值）
    chunkSize: storeConfig.chunkSize,
    fileConcurrency: storeConfig.fileConcurrency,
    chunkConcurrency: storeConfig.chunkConcurrency,
    maxRetries: storeConfig.maxRetries,
    hashMode: contextConfig.hashMode,

    // UI 配置（允许运行时修改）
    autoUpload: storeConfig.autoUpload,
    autoCleanup: storeConfig.autoCleanup,
    cleanupDelay: storeConfig.cleanupDelay,
    networkDisplayMode: storeConfig.networkDisplayMode,
    uiMode: contextConfig.uiMode,
    settingsSource: contextConfig.settingsSource,
    debug: contextConfig.debug,
    visibleColumns: stableVisibleColumns,

    // 回调函数（来自 Context）
    onUploadStart: contextConfig.onUploadStart,
    onUploadProgress: contextConfig.onUploadProgress,
    onUploadProgressDetail: contextConfig.onUploadProgressDetail,
    onUploadComplete: contextConfig.onUploadComplete,
    onUploadError: contextConfig.onUploadError,
    onBatchComplete: contextConfig.onBatchComplete,

    // 自定义方法（来自 Context）
    customFileValidator: contextConfig.customFileValidator,
    customUploadHandler: contextConfig.customUploadHandler,

    // 鉴权配置（来自 Context，每次上传前再解析为请求头）
    authToken: contextConfig.authToken,
    getAuthToken: contextConfig.getAuthToken,
    getAuthHeaders: contextConfig.getAuthHeaders,
    authScheme: contextConfig.authScheme,
    withCredentials: contextConfig.withCredentials,
  }), [
    contextConfig.baseURL,
    contextConfig.uploadApi,
    contextConfig.checkApi,
    contextConfig.mergeApi,
    contextConfig.maxFileSize,
    stableAllowedFileTypes,
    contextConfig.maxFiles,
    contextConfig.chunkCacheMaxFileSize,
    contextConfig.onUploadStart,
    contextConfig.onUploadProgress,
    contextConfig.onUploadProgressDetail,
    contextConfig.onUploadComplete,
    contextConfig.onUploadError,
    contextConfig.onBatchComplete,
    contextConfig.customFileValidator,
    contextConfig.customUploadHandler,
    contextConfig.uiMode,
    contextConfig.settingsSource,
    contextConfig.debug,
    stableVisibleColumns,
    contextConfig.authToken,
    contextConfig.getAuthToken,
    contextConfig.getAuthHeaders,
    contextConfig.authScheme,
    contextConfig.withCredentials,
    storeConfig.chunkSize,
    storeConfig.fileConcurrency,
    storeConfig.chunkConcurrency,
    storeConfig.maxRetries,
    contextConfig.hashMode,
    storeConfig.autoUpload,
    storeConfig.autoCleanup,
    storeConfig.cleanupDelay,
    storeConfig.networkDisplayMode,
  ]);
};
