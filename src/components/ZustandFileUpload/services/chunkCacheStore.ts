/**
 * 分片字节缓存存储层：把未确认成功的分片字节落进 IndexedDB，供刷新后零点击续传。
 *
 * 独立性：
 * - 独立数据库 `react-upload-chunks`，与元数据库 `react-upload-indexeddb` 分离；
 * - 只依赖 `indexedDB` 全局，不依赖 localforage / DOM，主线程与上传 Worker 共用。
 *
 * 键设计（数组主键，便于按实例 / 文件做前缀范围删除）：
 * - `chunks`：`[instanceId, fileId, chunkIndex]` → ArrayBuffer
 * - `files` ：`[instanceId, fileId]` → {@link ChunkCacheMeta}
 *
 * 提交语义：分片逐个写入，元数据最后写入；只有 `state:"ready"` 的元数据代表
 * 缓存完整。写到一半刷新会留下无元数据的分片，按缓存缺失降级为重新选择文件，
 * 并由清理逻辑回收。
 */

export const CHUNK_CACHE_DB_NAME = "react-upload-chunks";
const CHUNK_CACHE_DB_VERSION = 2;
const CHUNKS_STORE = "chunks";
const FILES_STORE = "files";
/**
 * 文件级 epoch（代际）存储：键 `[instanceId, fileId]` → number。
 * 用途（T-53）：主线程预热与上传 Worker 跨线程协作，必须有一份两端都可见的
 * 「当前代际」。上传每确认/清理一个分片即 bump 该值；预热写入分片时携带它开始
 * 预热时捕获的代际，store 内比对——若当前代际已更大（说明上传已接管该文件），
 * 过期的预热写回直接忽略，避免「已确认分片被预热写回成为孤儿分片」。
 */
const GENERATIONS_STORE = "generations";
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
  /**
   * T-54：缓存起始分片下标。已确认上传的分片（`index < cachedFromIndex`）不再落盘，
   * 缓存只为「尚未确认、需续传」的分片服务；读取端只应消费 `[cachedFromIndex, chunkCount)`
   * 范围。缺省 0 表示全量缓存（首次选择 / 刷新后重新预热场景）。
   */
  cachedFromIndex?: number;
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
      if (!db.objectStoreNames.contains(GENERATIONS_STORE)) {
        db.createObjectStore(GENERATIONS_STORE);
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

/** 在事务内同步读取一个值（供 epoch 比对等原子操作使用）。 */
const idbGet = <T>(
  store: IDBObjectStore,
  key: IDBValidKey,
): Promise<T | undefined> =>
  new Promise<T | undefined>((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error ?? new Error("读取失败"));
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

/**
 * 批量写入分片（不写元数据；元数据由 {@link putFileCacheMeta} 最后提交）。
 *
 * `generation` 为调用方开始预热时捕获的文件代际。store 内做原子比对：若文件当前
 * 代际已大于 `generation`（说明上传 Worker 已确认/清理过该文件，T-53 的竞态场景），
 * 整批写入被忽略并返回 0——过期预热写回的分片不会成为孤儿分片。
 *
 * @returns 实际写入的分片数（0 表示本批因代际过期被整体忽略）
 */
export const putCachedChunks = async (
  key: ChunkCacheKey,
  chunks: ReadonlyArray<{ index: number; data: ArrayBuffer }>,
  generation = 0,
): Promise<number> => {
  if (chunks.length === 0) {
    return 0;
  }
  const db = await openDb();
  let totalWritten = 0;

  for (let offset = 0; offset < chunks.length; offset += WRITE_BATCH_SIZE) {
    const tx = db.transaction([CHUNKS_STORE, GENERATIONS_STORE], "readwrite");
    const genStore = tx.objectStore(GENERATIONS_STORE);
    const currentGen =
      (await idbGet<number>(genStore, [key.instanceId, key.fileId])) ?? 0;
    if (currentGen > generation) {
      // 代际过期：上传已接管，过期预热写回必须忽略（T-53）。关闭本事务，跳过写入。
      await txDone(tx);
      continue;
    }
    const store = tx.objectStore(CHUNKS_STORE);
    for (const chunk of chunks.slice(offset, offset + WRITE_BATCH_SIZE)) {
      store.put(chunk.data, [key.instanceId, key.fileId, chunk.index]);
    }
    await txDone(tx);
    totalWritten += chunks.slice(offset, offset + WRITE_BATCH_SIZE).length;
  }

  return totalWritten;
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

/** 读取文件当前代际（缺省 0）。 */
export const readGeneration = async (key: ChunkCacheKey): Promise<number> => {
  const db = await openDb();
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction(GENERATIONS_STORE, "readonly");
    const request = tx
      .objectStore(GENERATIONS_STORE)
      .get([key.instanceId, key.fileId]);
    request.onsuccess = () =>
      resolve((request.result as number | undefined) ?? 0);
    request.onerror = () => reject(request.error ?? new Error("读取代际失败"));
  });
};

/**
 * 删除单个分片（服务端确认成功 / 已存在的分片）。
 *
 * 同一事务内：删片 + 移除 ready 提交标记（T-52 的「ready ≡ 分片齐全」）+ **bump
 * 文件代际**（T-53 的跨线程 epoch）。代际 bump 让仍在进行的预热感知到「该分片已被
 * 上传接管」，其后续的过期写回在 {@link putCachedChunks} 处被忽略。
 */
export const deleteCachedChunk = async (
  key: ChunkCacheKey,
  index: number,
): Promise<void> => {
  const db = await openDb();
  const tx = db.transaction(
    [CHUNKS_STORE, FILES_STORE, GENERATIONS_STORE],
    "readwrite",
  );
  tx.objectStore(CHUNKS_STORE).delete([key.instanceId, key.fileId, index]);
  // T-52：跨两 store 同一事务——原本完整的 ready 缓存删掉任一分片后即不再完整，
  // 若保留 ready meta，读取端会误判为可零点击续传，实则缺片，刷新后续传会在缺失
  // 分片处被 ChunkCacheMissError 二次降级（数据一致性缺陷）。
  tx.objectStore(FILES_STORE).delete([key.instanceId, key.fileId]);
  // T-53：bump 代际，使过期预热写回失效。
  const genStore = tx.objectStore(GENERATIONS_STORE);
  const genKey = [key.instanceId, key.fileId];
  const currentGen = (await idbGet<number>(genStore, genKey)) ?? 0;
  genStore.put(currentGen + 1, genKey);
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

/**
 * T-55：代际原子的就绪标记写入。仅当文件当前代际仍等于 `expectedGeneration` 时才写入，
 * 否则返回 false（不写）。与上传/清理的 {@link deleteFileCache}（它会 bump 代际）在
 * 同一 IndexedDB 连接下事务串行互斥，从而消除「预热写完分片后、写标记前被清理」的竞态：
 * 若清理先 bump 代际，本函数读到更大代际即跳过写标记，最终磁盘状态由清理决定（无分片、
 * 无 ready meta），不会出现「ready meta + 零分片」的误导状态。
 *
 * @returns 是否真正写入了标记
 */
export const putFileCacheMetaIfGeneration = async (
  key: ChunkCacheKey,
  meta: ChunkCacheMeta,
  expectedGeneration: number
): Promise<boolean> => {
  const db = await openDb();
  const tx = db.transaction([FILES_STORE, GENERATIONS_STORE], "readwrite");
  const genStore = tx.objectStore(GENERATIONS_STORE);
  const currentGen =
    (await idbGet<number>(genStore, [key.instanceId, key.fileId])) ?? 0;
  if (currentGen !== expectedGeneration) {
    // 代际已变（上传/清理已接管该文件）：不写标记，把磁盘状态交给清理决定。
    await txDone(tx);
    return false;
  }
  tx.objectStore(FILES_STORE).put(meta, [key.instanceId, key.fileId]);
  await txDone(tx);
  return true;
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
  const tx = db.transaction(
    [CHUNKS_STORE, FILES_STORE, GENERATIONS_STORE],
    "readwrite",
  );
  deleteRange(tx.objectStore(CHUNKS_STORE), fileRange(key));
  tx.objectStore(FILES_STORE).delete([key.instanceId, key.fileId]);
  // T-53：合并完成后的最终清理也必须 bump 代际——此时预热可能仍在后台写回，
  // 若不清代际，预热会在本清理之后再写回孤儿分片。bump 后其过期写回被忽略。
  const genStore = tx.objectStore(GENERATIONS_STORE);
  const genKey = [key.instanceId, key.fileId];
  const currentGen = (await idbGet<number>(genStore, genKey)) ?? 0;
  genStore.put(currentGen + 1, genKey);
  await txDone(tx);
};

/** 清空单个实例的全部缓存（清空列表 / 实例卸载场景）。 */
export const clearInstanceCache = async (instanceId: string): Promise<void> => {
  const db = await openDb();
  const tx = db.transaction(
    [CHUNKS_STORE, FILES_STORE, GENERATIONS_STORE],
    "readwrite",
  );
  const range = instanceRange(instanceId);
  deleteRange(tx.objectStore(CHUNKS_STORE), range);
  deleteRange(tx.objectStore(FILES_STORE), range);
  deleteRange(tx.objectStore(GENERATIONS_STORE), range);
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
