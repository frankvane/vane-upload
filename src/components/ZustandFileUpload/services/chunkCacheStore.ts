/**
 * 分片字节缓存存储层（方案 A：刷新零点击续传）。
 *
 * 背景：元数据（hash / chunkSize / chunkCount / 进度）一直持久化在 localforage
 * 的 `react-upload-indexeddb`；但文件字节此前只存在于当前会话内存（fileRef），
 * 刷新即丢失，续传必须让用户重新选择文件。本模块把「尚未确认上传成功的分片」
 * 字节真正落进 IndexedDB，刷新后可直接重建文件数据继续上传。
 *
 * 独立性：
 * - 使用独立数据库 `react-upload-chunks`，与元数据库分离，避免影响既有 schema；
 * - 只依赖 `indexedDB` 全局，不依赖 localforage / DOM，主线程与上传 Worker 共用。
 *
 * 键设计（数组主键，便于按实例 / 文件做前缀范围删除）：
 * - `chunks`：`[instanceId, fileId, chunkIndex]` → ArrayBuffer（分片字节）
 * - `files` ：`[instanceId, fileId]` → {@link ChunkCacheMeta}
 *
 * 提交语义：分片逐个写入，**元数据最后写入**；只有存在 `state:"ready"` 的
 * 元数据才视为“缓存完整、刷新后可续传”。写到一半刷新会留下无元数据的分片，
 * 按缓存缺失处理（降级为重新选择文件），并由清理逻辑回收。
 */

export const CHUNK_CACHE_DB_NAME = "react-upload-chunks";
const CHUNK_CACHE_DB_VERSION = 1;
const CHUNKS_STORE = "chunks";
const FILES_STORE = "files";
/** 每批写入的分片数：单事务过大时部分浏览器会提前提交，分批更稳。 */
const WRITE_BATCH_SIZE = 16;

/**
 * 缓存就绪标记（提交标记）。
 * 只在全部分片写完后写入，因此它的存在等价于“缓存覆盖了完整文件”。
 */
export interface ChunkCacheMeta {
  state: "ready";
  fileName: string;
  fileSize: number;
  fileType: string;
  lastModified: number;
  hash?: string;
  chunkSize: number;
  chunkCount: number;
  createdAt: number;
}

export interface ChunkCacheKey {
  instanceId: string;
  fileId: string;
}

class ChunkCacheUnsupportedError extends Error {
  constructor(message = "当前环境不支持 IndexedDB，无法持久化分片缓存") {
    super(message);
    this.name = "ChunkCacheUnsupportedError";
  }
}

export const isChunkCacheSupported = (): boolean =>
  typeof indexedDB !== "undefined" && indexedDB !== null;

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
  if (!isChunkCacheSupported()) {
    return Promise.reject(new ChunkCacheUnsupportedError());
  }
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(CHUNK_CACHE_DB_NAME, CHUNK_CACHE_DB_VERSION);
    } catch (error) {
      dbPromise = null;
      reject(error);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
        db.createObjectStore(CHUNKS_STORE);
      }
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        db.createObjectStore(FILES_STORE);
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // 其它标签页升级 schema 时主动让出连接，避免本连接把对方 blocked。
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error("无法打开分片缓存数据库"));
    };

    request.onblocked = () => {
      dbPromise = null;
      reject(new Error("分片缓存数据库被其它页面占用"));
    };
  });

  return dbPromise;
};

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("分片缓存事务失败"));
    tx.onabort = () => reject(tx.error ?? new Error("分片缓存事务已中止"));
  });

/** 单个文件的键范围：`[instanceId, fileId, 0] ~ [instanceId, fileId, MAX]` */
const fileRange = (key: ChunkCacheKey): IDBKeyRange =>
  IDBKeyRange.bound(
    [key.instanceId, key.fileId, 0],
    [key.instanceId, key.fileId, Number.MAX_SAFE_INTEGER],
  );

/**
 * 单个实例的键范围。数组键的元素类型序为 number < string < array，
 * 因此上界 `[instanceId, []]` 大于该实例下任意字符串第二键的键。
 */
const instanceRange = (instanceId: string): IDBKeyRange =>
  IDBKeyRange.bound([instanceId], [instanceId, []]);

const deleteRange = (
  store: IDBObjectStore,
  range: IDBKeyRange,
): void => {
  const request = store.openKeyCursor(range);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) {
      return;
    }
    store.delete(cursor.key);
    cursor.continue();
  };
};

/** 批量写入分片（不写元数据；元数据由 {@link putFileCacheMeta} 最后提交）。 */
export const putCachedChunks = async (
  key: ChunkCacheKey,
  chunks: ReadonlyArray<{ index: number; data: ArrayBuffer }>,
): Promise<void> => {
  if (chunks.length === 0) {
    return;
  }
  const db = await openDb();

  for (let offset = 0; offset < chunks.length; offset += WRITE_BATCH_SIZE) {
    const tx = db.transaction(CHUNKS_STORE, "readwrite");
    const store = tx.objectStore(CHUNKS_STORE);
    for (const chunk of chunks.slice(offset, offset + WRITE_BATCH_SIZE)) {
      store.put(chunk.data, [key.instanceId, key.fileId, chunk.index]);
    }
    await txDone(tx);
  }
};

/** 读取单个分片；不存在（或被清理）时返回 undefined。 */
export const readCachedChunk = async (
  key: ChunkCacheKey,
  index: number,
): Promise<ArrayBuffer | undefined> => {
  const db = await openDb();
  return new Promise<ArrayBuffer | undefined>((resolve, reject) => {
    const tx = db.transaction(CHUNKS_STORE, "readonly");
    const request = tx
      .objectStore(CHUNKS_STORE)
      .get([key.instanceId, key.fileId, index]);
    request.onsuccess = () =>
      resolve(request.result as ArrayBuffer | undefined);
    request.onerror = () =>
      reject(request.error ?? new Error("读取分片缓存失败"));
  });
};

/** 删除单个分片（服务端确认成功 / 已存在的分片）。 */
export const deleteCachedChunk = async (
  key: ChunkCacheKey,
  index: number,
): Promise<void> => {
  const db = await openDb();
  const tx = db.transaction(CHUNKS_STORE, "readwrite");
  tx.objectStore(CHUNKS_STORE).delete([key.instanceId, key.fileId, index]);
  await txDone(tx);
};

/** 写入就绪元数据（提交标记）：必须在全部分片写完之后调用。 */
export const putFileCacheMeta = async (
  key: ChunkCacheKey,
  meta: ChunkCacheMeta,
): Promise<void> => {
  const db = await openDb();
  const tx = db.transaction(FILES_STORE, "readwrite");
  tx.objectStore(FILES_STORE).put(meta, [key.instanceId, key.fileId]);
  await txDone(tx);
};

/** 读取就绪元数据；不存在或不是 ready 时返回 undefined。 */
export const getFileCacheMeta = async (
  key: ChunkCacheKey,
): Promise<ChunkCacheMeta | undefined> => {
  const db = await openDb();
  return new Promise<ChunkCacheMeta | undefined>((resolve, reject) => {
    const tx = db.transaction(FILES_STORE, "readonly");
    const request = tx
      .objectStore(FILES_STORE)
      .get([key.instanceId, key.fileId]);
    request.onsuccess = () => {
      const meta = request.result as ChunkCacheMeta | undefined;
      resolve(meta?.state === "ready" ? meta : undefined);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("读取分片缓存元数据失败"));
  });
};

/** 一次游标遍历列出该实例下所有就绪文件 id（挂载恢复用）。 */
export const listReadyFileIds = async (
  instanceId: string,
): Promise<Set<string>> => {
  const db = await openDb();
  const readyIds = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(FILES_STORE, "readonly");
    const request = tx
      .objectStore(FILES_STORE)
      .openCursor(instanceRange(instanceId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const [scopedInstance, fileId] = cursor.key as [string, string];
      const meta = cursor.value as ChunkCacheMeta;
      if (scopedInstance === instanceId && meta?.state === "ready") {
        readyIds.add(fileId);
      }
      cursor.continue();
    };
    request.onerror = () =>
      reject(request.error ?? new Error("列举分片缓存失败"));
  });

  return readyIds;
};

/** 删除单个文件的全部缓存（分片 + 元数据），一次事务完成。 */
export const deleteFileCache = async (key: ChunkCacheKey): Promise<void> => {
  const db = await openDb();
  const tx = db.transaction([CHUNKS_STORE, FILES_STORE], "readwrite");
  deleteRange(tx.objectStore(CHUNKS_STORE), fileRange(key));
  tx.objectStore(FILES_STORE).delete([key.instanceId, key.fileId]);
  await txDone(tx);
};

/** 清空单个实例的全部缓存（清空列表 / 实例卸载场景）。 */
export const clearInstanceCache = async (instanceId: string): Promise<void> => {
  const db = await openDb();
  const tx = db.transaction([CHUNKS_STORE, FILES_STORE], "readwrite");
  const range = instanceRange(instanceId);
  deleteRange(tx.objectStore(CHUNKS_STORE), range);
  deleteRange(tx.objectStore(FILES_STORE), range);
  await txDone(tx);
};

/**
 * 关闭当前数据库连接（仅测试使用；生产环境随页面存活）。
 * 关闭后下一次访问会重新打开。
 */
export const closeChunkCacheDb = async (): Promise<void> => {
  const pending = dbPromise;
  dbPromise = null;
  if (!pending) {
    return;
  }
  try {
    (await pending).close();
  } catch {
    // 打开失败时无需关闭
  }
};
