import localforage from "localforage";

import type { UploadStorage } from "../types/upload";
import { stampUploadSchema } from "./uploadSchema";

/**
 * 每实例上传存储：每个 <FileUpload> 实例持有一个具名 localforage createInstance。
 *
 * 库数据落在独立的 IndexedDB（name: "react-upload-indexeddb"），不触碰消费方
 * 的默认 localforage 实例，因此 `localforage.clear()` 不会误删消费方数据。
 * instanceId 用于多实例隔离：不同 id 使用不同 storeName；不传时回落到固定
 * storeName（"upload_files"），保持单实例场景的刷新续传行为。
 */
export const DEFAULT_UPLOAD_DB_NAME = "react-upload-indexeddb";
export const DEFAULT_UPLOAD_STORE_NAME = "upload_files";

/**
 * P2-4：写入统一盖章 `schemaVersion`。
 * 在存储实例层做一次包装，避免散落在各处的 `storage.setItem` 漏掉版本号。
 */
const withSchemaVersion = (store: UploadStorage): UploadStorage => {
  const wrapped = Object.create(store) as UploadStorage;
  wrapped.setItem = ((key: string, value: unknown, callback?: unknown) =>
    store.setItem(
      key,
      stampUploadSchema(value) as never,
      callback as never
    )) as UploadStorage["setItem"];
  return wrapped;
};

export const createUploadStorage = (instanceId?: string): UploadStorage =>
  withSchemaVersion(
    localforage.createInstance({
      name: DEFAULT_UPLOAD_DB_NAME,
      storeName: instanceId
        ? `${DEFAULT_UPLOAD_STORE_NAME}_${instanceId}`
        : DEFAULT_UPLOAD_STORE_NAME,
      description:
        "大文件分片上传元数据（分片字节另存于 react-upload-chunks，用于刷新续传）",
    })
  );
