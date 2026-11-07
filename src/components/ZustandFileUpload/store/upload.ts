import {
  BatchInfo,
  ProcessProgress,
  UploadConfig,
  UploadFile,
  UploadSettingsSource,
} from "../types/upload";
import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { create, type StoreApi } from "zustand";
import { message } from "../../../ui";
import type { MessageInstance } from "../../../ui";
import { listUploadFiles } from "../services/uploadStorage";
import { safeStorage } from "../../../shared/safeStorage";

type ProgressMapUpdater =
  | Record<string, number>
  | ((prev: Record<string, number>) => Record<string, number>);

type BatchInfoUpdater =
  | BatchInfo
  | null
  | ((prev: BatchInfo | null) => BatchInfo | null);

type FileTimingsUpdater =
  | Record<string, number>
  | ((prev: Record<string, number>) => Record<string, number>);

type RetryingFilesUpdater =
  | Record<string, boolean>
  | ((prev: Record<string, boolean>) => Record<string, boolean>);

export interface UploadState {
  files: UploadFile[];
  progressMap: Record<string, number>;
  /** T3.4：字节级速率（字节/秒）按 fileId 索引，供 UI 展示 */
  speedMap: Record<string, number>;
  /** T3.4：预计剩余时间（秒）按 fileId 索引，供 UI 展示 */
  etaMap: Record<string, number>;
  retryingFiles: Record<string, boolean>;

  batchInfo: BatchInfo | null;
  processProgress: ProcessProgress | null;
  fileTimings: Record<string, number>;

  isUploading: boolean;
  isRetryingAll: boolean;
  loading: boolean;
  cost: number | null;

  networkType: string;
  fileConcurrency: number;
  chunkConcurrency: number;
  chunkSize: number;
  maxRetries: number;
  isNetworkOffline: boolean;

  autoUpload: boolean;
  autoCleanup: boolean;
  cleanupDelay: number;
  networkDisplayMode: "tooltip" | "direct";
  storageStatsVisible: boolean;

  config: UploadConfig | null;

  setFiles: (files: UploadFile[]) => void;
  /** 局部更新某文件的部分字段（T3.3：暂停/继续即时反馈） */
  patchFile: (id: string, patch: Partial<UploadFile>) => void;
  refreshFiles: () => Promise<void>;
  setProgressMap: (progressMap: ProgressMapUpdater) => void;
  setSpeedMap: (
    speedMap:
      | Record<string, number>
      | ((prev: Record<string, number>) => Record<string, number>)
  ) => void;
  setEtaMap: (
    etaMap:
      | Record<string, number>
      | ((prev: Record<string, number>) => Record<string, number>)
  ) => void;
  setBatchInfo: (batchInfo: BatchInfoUpdater) => void;
  setProcessProgress: (progress: ProcessProgress | null) => void;
  setFileTimings: (timings: FileTimingsUpdater) => void;
  setIsUploading: (isUploading: boolean) => void;
  setIsRetryingAll: (isRetryingAll: boolean) => void;
  setLoading: (loading: boolean) => void;
  setCost: (cost: number | null) => void;
  setAutoUpload: (autoUpload: boolean) => void;
  setAutoCleanup: (autoCleanup: boolean) => void;
  setCleanupDelay: (delay: number) => void;
  setNetworkDisplayMode: (mode: "tooltip" | "direct") => void;
  setStorageStatsVisible: (visible: boolean) => void;
  setRetryingFiles: (files: RetryingFilesUpdater) => void;
  setConfig: (config: UploadConfig) => void;

  getMessageApi: () => MessageInstance;
  initSettings: (defaults?: {
    autoUpload?: boolean;
    autoCleanup?: boolean;
    cleanupDelay?: number;
    networkDisplayMode?: "tooltip" | "direct";
    settingsSource?: UploadSettingsSource;
  }) => void;
}

export type UploadStore = StoreApi<UploadState>;

/**
 * 创建每实例上传状态仓库（T3.2 单例治理）。
 *
 * 原 `useUploadStore` 是模块级 zustand `create()` 单例，导致同页多个
 * <FileUpload> 实例共享同一份状态（文件列表、进度、config 互相串）。
 * 现改为工厂：每个组件实例持有独立仓库，经 UploadStoreContext 下发。
 *
 * @param storage 该实例对应的 IndexedDB 存储（由 createUploadStorage 创建），
 *                供 refreshFiles 读取持久化元数据。
 */
export const createUploadStore = (storage: LocalForage): UploadStore =>
  create<UploadState>((set) => ({
    files: [],
    progressMap: {},
    speedMap: {},
    etaMap: {},
    retryingFiles: {},
    batchInfo: null,
    processProgress: null,
    fileTimings: {},
    isUploading: false,
    isRetryingAll: false,
    loading: false,
    cost: null,
    networkType: "unknown",
    fileConcurrency: 2,
    chunkConcurrency: 2,
    chunkSize: 1024 * 1024,
    maxRetries: 3,
    isNetworkOffline: false,
    autoUpload: true,
    autoCleanup: true,
    cleanupDelay: 10,
    networkDisplayMode: "tooltip",
    storageStatsVisible: false,
    config: null,

    setFiles: (files) => set({ files }),
    patchFile: (id, patch) =>
      set((state) => ({
        files: state.files.map((f) =>
          f.id === id ? { ...f, ...patch } : f
        ),
      })),
    refreshFiles: async () => {
      const files = await listUploadFiles(storage);
      set({ files });
    },
    setProgressMap: (progressMap) =>
      set((state) => ({
        progressMap:
          typeof progressMap === "function"
            ? progressMap(state.progressMap)
            : progressMap,
      })),
    setSpeedMap: (speedMap) =>
      set((state) => ({
        speedMap:
          typeof speedMap === "function" ? speedMap(state.speedMap) : speedMap,
      })),
    setEtaMap: (etaMap) =>
      set((state) => ({
        etaMap: typeof etaMap === "function" ? etaMap(state.etaMap) : etaMap,
      })),
    setBatchInfo: (batchInfo) =>
      set((state) => ({
        batchInfo:
          typeof batchInfo === "function"
            ? batchInfo(state.batchInfo)
            : batchInfo,
      })),
    setProcessProgress: (processProgress) => set({ processProgress }),
    setFileTimings: (fileTimings) =>
      set((state) => ({
        fileTimings:
          typeof fileTimings === "function"
            ? fileTimings(state.fileTimings)
            : fileTimings,
      })),
    setIsUploading: (isUploading) => set({ isUploading }),
    setIsRetryingAll: (isRetryingAll) => set({ isRetryingAll }),
    setLoading: (loading) => set({ loading }),
    setCost: (cost) => set({ cost }),
    setAutoUpload: (autoUpload) => {
      safeStorage.setItem("autoUpload", autoUpload);
      set({ autoUpload });
    },
    setAutoCleanup: (autoCleanup) => {
      safeStorage.setItem("autoCleanup", autoCleanup);
      set({ autoCleanup });
    },
    setCleanupDelay: (delay) => {
      safeStorage.setItem("cleanupDelay", delay);
      set({ cleanupDelay: delay });
    },
    setNetworkDisplayMode: (networkDisplayMode) => {
      safeStorage.setItem("networkDisplayMode", networkDisplayMode);
      set({ networkDisplayMode });
    },
    setStorageStatsVisible: (storageStatsVisible) =>
      set({ storageStatsVisible }),
    setRetryingFiles: (retryingFiles) =>
      set((state) => ({
        retryingFiles:
          typeof retryingFiles === "function"
            ? retryingFiles(state.retryingFiles)
            : retryingFiles,
      })),
    setConfig: (config) => {
      set({
        config,
        chunkSize: config.chunkSize,
        fileConcurrency: config.fileConcurrency,
        chunkConcurrency: config.chunkConcurrency,
        maxRetries: config.maxRetries,
      });
    },

    initSettings: (defaults) => {
      const settingsSource = defaults?.settingsSource ?? "localStorage";

      // F1：经 safeStorage 读取（try/catch + rui: 前缀 + 旧 key 回退 + 类型校验），
      // 避免隐私模式/损坏数据导致初始化抛错。settingsSource 为 props 时不读本地。
      const readLocal = <T,>(key: string, fallback: T): T =>
        settingsSource === "localStorage"
          ? safeStorage.getItem(key, fallback)
          : fallback;

      const autoUpload = readLocal("autoUpload", defaults?.autoUpload ?? true);
      const autoCleanup = readLocal(
        "autoCleanup",
        defaults?.autoCleanup ?? true
      );
      const cleanupDelay = readLocal(
        "cleanupDelay",
        defaults?.cleanupDelay ?? 10
      );
      const networkDisplayMode = readLocal(
        "networkDisplayMode",
        (defaults?.networkDisplayMode ?? "tooltip") as "tooltip" | "direct"
      );

      set({ autoUpload, autoCleanup, cleanupDelay, networkDisplayMode });
    },

    getMessageApi: () => message,
  }));

export const UploadStoreContext = createContext<UploadStore | null>(null);

/**
 * 组件内读取上传状态（T3.2：从 UploadStoreContext 取每实例仓库）。
 * 等价于原 `useUploadStore(selector)`，调用方无需改动。
 */
export function useUploadStore<T>(selector: (state: UploadState) => T): T {
  const store = useContext(UploadStoreContext);
  if (store === null) {
    throw new Error("useUploadStore 必须在 UploadProvider 内使用");
  }
  return useStore(store, selector);
}

/**
 * 逃生舱：获取当前实例的仓库 API，供非 hook 上下文（如命令式回调、
 * 定时器闭包）调用 getState()/setState()。须在 UploadProvider 内调用。
 */
export function useUploadStoreApi(): UploadStore {
  const store = useContext(UploadStoreContext);
  if (store === null) {
    throw new Error("useUploadStoreApi 必须在 UploadProvider 内使用");
  }
  return store;
}
