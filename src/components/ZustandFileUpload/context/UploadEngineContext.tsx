import { createContext, useContext } from "react";
import type { StoreApi } from "zustand";
import type { UploadState } from "../store/upload";
import type { FileRegistry } from "../services/fileRegistry";
import type { UploadWorkerPool } from "../services/uploadWorkerBridge";

/**
 * 每实例上传引擎（T3.2 单例治理的聚合载体）。
 *
 * 把原本散落在模块级的单例——状态仓库、IndexedDB 存储、File 引用注册表、
 * 上传 Worker 池——聚合成一个随 <FileUpload> 实例生命周期存在的对象，
 * 经 UploadEngineContext 下发给 hooks / services，从而：
 * - 同页多个实例互不串数据（各自独立的 store / storage / registry / pool）；
 * - 卸载时仅释放自身持有的资源（pool.dispose / registry.releaseAllFileRefs），
 *   不影响其他实例。
 */
export interface UploadEngine {
  /** 实例标识，用于隔离 IndexedDB storeName（不传则回落默认） */
  instanceId: string;
  /** 该实例的 IndexedDB 存储（createUploadStorage 产物） */
  storage: LocalForage;
  /** 该实例的 File 引用注册表（createFileRegistry 产物） */
  fileRegistry: FileRegistry;
  /** 该实例的上传 Worker 池（createUploadWorkerPool 产物） */
  workerPool: UploadWorkerPool;
  /** 该实例的状态仓库 API（createUploadStore 产物） */
  store: StoreApi<UploadState>;
}

export const UploadEngineContext = createContext<UploadEngine | null>(null);

export function useUploadEngine(): UploadEngine {
  const ctx = useContext(UploadEngineContext);
  if (ctx === null) {
    throw new Error("useUploadEngine 必须在 UploadProvider 内使用");
  }
  return ctx;
}
