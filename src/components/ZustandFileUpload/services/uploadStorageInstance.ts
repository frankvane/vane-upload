import localforage from "localforage";

import { stampUploadSchema } from "./uploadSchema";

/**
 * 每实例上传存储（T3.2 单例治理）。
 *
 * 此前上传侧直接使用 localforage 的【默认实例】（在 index.tsx 顶层调用
 * `localforage.config(...)` 改变全局默认实例），这会污染消费方的默认
 * localforage 数据，且 `localforage.clear()` 会误删消费方数据。
 *
 * 现改为每个 <FileUpload> 实例持有一个具名 createInstance：
 * - 库数据落在独立的 IndexedDB（name: "react-upload-indexeddb"），不触碰消费方默认实例；
 * - instanceId 用于多实例隔离：传不同 id 的两个实例使用不同 storeName，互不串数据；
 *   不传时回落到固定 storeName（"upload_files"），保持单实例场景下的刷新续传行为。
 */
export const DEFAULT_UPLOAD_DB_NAME = "react-upload-indexeddb";
export const DEFAULT_UPLOAD_STORE_NAME = "upload_files";

/**
 * P2-4：写入统一盖章 `schemaVersion`。
 * 在存储实例层做一次包装，避免散落在各处的 `storage.setItem` 漏掉版本号。
 */
const withSchemaVersion = (store: LocalForage): LocalForage => {
  const wrapped = Object.create(store) as LocalForage;
  wrapped.setItem = ((key: string, value: unknown, callback?: unknown) =>
    store.setItem(
      key,
      stampUploadSchema(value) as never,
      callback as never
    )) as LocalForage["setItem"];
  return wrapped;
};

export const createUploadStorage = (instanceId?: string): LocalForage =>
  withSchemaVersion(
    localforage.createInstance({
      name: DEFAULT_UPLOAD_DB_NAME,
      storeName: instanceId
        ? `${DEFAULT_UPLOAD_STORE_NAME}_${instanceId}`
        : DEFAULT_UPLOAD_STORE_NAME,
      description: "大文件分片上传元数据（仅存元数据，不存文件字节）",
    })
  );
