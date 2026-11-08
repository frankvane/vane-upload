/**
 * 分片缓存编排层（主线程）：预热、就绪判定、配额/上限降级与清理。
 *
 * 与 {@link ./chunkCacheStore} 分工：
 * - store 只做原始 IndexedDB 读写，Worker 也可直接使用；
 * - 本模块负责“何时缓存、缓存到什么程度、失败如何降级”，并持有同一文件的
 *   预热 Promise（文件选择与上传启动可能同时触发预热，必须共享同一次写入）。
 *
 * 核心不变量：**上传启动前必须完成全部待传分片的缓存**。
 * 缺少这条保证，刷新后缓存只覆盖部分分片，续传会静默丢数据；因此
 * {@link primeChunkCache} 成功（或已有就绪元数据）才视为可续传，
 * 否则由调用方明确降级为「刷新后需重新选择文件」。
 */

import type { UploadFile } from "../types/upload";
import {
  deleteFileCache,
  getFileCacheMeta,
  isChunkCacheSupported,
  putCachedChunks,
  putFileCacheMeta,
  clearInstanceCache,
  type ChunkCacheKey,
} from "./chunkCacheStore";

/** 单文件缓存上限默认值（512MB）：超过则不缓存，并明确提示刷新后需重选。 */
export const DEFAULT_CHUNK_CACHE_MAX_FILE_SIZE = 512 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
/** 配额预检留白：预计占用超过可用配额 90% 时放弃缓存，避免写一半失败。 */
const QUOTA_SAFETY_RATIO = 0.9;

export type ChunkCacheStatus = "ready" | "skipped" | "unavailable";

export interface ChunkCacheOptions {
  instanceId: string;
  /** 单文件缓存上限（字节），缺省 {@link DEFAULT_CHUNK_CACHE_MAX_FILE_SIZE} */
  maxFileSize?: number;
}

interface PrimeEntry {
  promise: Promise<ChunkCacheStatus>;
  cancelled: boolean;
}

const primeEntries = new Map<string, PrimeEntry>();

const entryKey = (instanceId: string, fileId: string): string =>
  `${instanceId}\u0000${fileId}`;

const toKeys = (instanceId: string, fileId: string): ChunkCacheKey => ({
  instanceId,
  fileId,
});

const readQuota = async (): Promise<{
  quota: number;
  usage: number;
} | null> => {
  try {
    const storage = typeof navigator !== "undefined" ? navigator.storage : null;
    if (!storage || typeof storage.estimate !== "function") {
      return null;
    }
    const estimate = await storage.estimate();
    if (!estimate) {
      return null;
    }
    return { quota: estimate.quota ?? 0, usage: estimate.usage ?? 0 };
  } catch {
    return null;
  }
};

const resolveChunkSize = (file: UploadFile): number =>
  file.chunkSize && file.chunkSize > 0 ? file.chunkSize : DEFAULT_CHUNK_SIZE;

const resolveChunkCount = (file: UploadFile, chunkSize: number): number =>
  file.chunkCount && file.chunkCount > 0
    ? file.chunkCount
    : Math.ceil(file.fileSize / chunkSize);

const runPrime = async (
  file: UploadFile,
  fileRef: File,
  options: ChunkCacheOptions,
  entry: PrimeEntry
): Promise<ChunkCacheStatus> => {
  const keys = toKeys(options.instanceId, file.id);
  const maxFileSize = options.maxFileSize ?? DEFAULT_CHUNK_CACHE_MAX_FILE_SIZE;

  // 超过上限：不缓存，由调用方提示「刷新后需重新选择文件」。
  if (file.fileSize > maxFileSize) {
    return "skipped";
  }
  if (!isChunkCacheSupported()) {
    return "unavailable";
  }

  const chunkSize = resolveChunkSize(file);
  const chunkCount = resolveChunkCount(file, chunkSize);

  try {
    // 已就绪（例如同一文件重复触发预热）：直接复用，不重复写。
    if (await getFileCacheMeta(keys)) {
      return "ready";
    }

    const quota = await readQuota();
    if (
      quota &&
      quota.quota > 0 &&
      quota.usage + file.fileSize > quota.quota * QUOTA_SAFETY_RATIO
    ) {
      return "unavailable";
    }

    let index = 0;
    while (index < chunkCount) {
      if (entry.cancelled) {
        await deleteFileCache(keys).catch(() => undefined);
        return "unavailable";
      }

      // 一次攒一批再交给 store 分事务写入，减少事务数量。
      const batch: Array<{ index: number; data: ArrayBuffer }> = [];
      const batchEnd = Math.min(chunkCount, index + 16);
      for (let cursor = index; cursor < batchEnd; cursor += 1) {
        const start = cursor * chunkSize;
        const end = Math.min(file.fileSize, start + chunkSize);
        // ArrayBuffer 在 IndexedDB 的结构化克隆支持面最广（Blob 在部分环境不可存）。
        batch.push({
          index: cursor,
          data: await fileRef.slice(start, end).arrayBuffer(),
        });
      }
      await putCachedChunks(keys, batch);
      index = batchEnd;
    }

    if (entry.cancelled) {
      await deleteFileCache(keys).catch(() => undefined);
      return "unavailable";
    }

    // 最后写入提交标记：此前任何中断都视为缓存不可用。
    await putFileCacheMeta(keys, {
      state: "ready",
      fileName: file.fileName,
      fileSize: file.fileSize,
      fileType: file.fileType,
      lastModified: file.lastModified,
      hash: file.hash,
      chunkSize,
      chunkCount,
      createdAt: file.createdAt,
    });
    return "ready";
  } catch {
    // 配额不足 / 隐私模式 / 写入被拒：回收半成品，明确降级。
    await deleteFileCache(keys).catch(() => undefined);
    return "unavailable";
  }
};

/**
 * 预热分片缓存（幂等，同一文件共享一次写入）。
 *
 * @returns ready=已完整落盘可刷新续传；skipped=超过大小上限；unavailable=环境/配额不可用
 */
export const primeChunkCache = (
  file: UploadFile,
  fileRef: File,
  options: ChunkCacheOptions
): Promise<ChunkCacheStatus> => {
  const key = entryKey(options.instanceId, file.id);
  const existing = primeEntries.get(key);
  if (existing) {
    return existing.promise;
  }

  const entry: PrimeEntry = {
    cancelled: false,
    promise: Promise.resolve("unavailable"),
  };
  entry.promise = runPrime(file, fileRef, options, entry);
  primeEntries.set(key, entry);
  return entry.promise;
};

/** 判定该文件当前是否具备“刷新后可续传”的缓存。 */
export const isFileCacheReady = async (
  instanceId: string,
  fileId: string
): Promise<boolean> => {
  const entry = primeEntries.get(entryKey(instanceId, fileId));
  if (entry) {
    return (await entry.promise) === "ready";
  }
  if (!isChunkCacheSupported()) {
    return false;
  }
  try {
    return Boolean(await getFileCacheMeta(toKeys(instanceId, fileId)));
  } catch {
    return false;
  }
};

/**
 * 清理单个文件的缓存（完成 / 取消 / 删除 / 终态失败）。
 * best-effort：缓存清理失败不回滚业务状态，避免阻塞删除。
 */
export const clearFileChunkCache = async (
  instanceId: string,
  fileId: string
): Promise<void> => {
  const key = entryKey(instanceId, fileId);
  const entry = primeEntries.get(key);
  if (entry) {
    // 先同步作废在途预热，防止清理后又被写回。
    entry.cancelled = true;
    primeEntries.delete(key);
  }
  try {
    await deleteFileCache(toKeys(instanceId, fileId));
  } catch {
    // 忽略：IndexedDB 不可用 / 数据库被占用时无缓存可清
  }
};

/** 清理该实例的全部缓存（清空列表）。 */
export const clearInstanceChunkCache = async (
  instanceId: string
): Promise<void> => {
  const prefix = `${instanceId}\u0000`;
  for (const [key, entry] of primeEntries) {
    if (key.startsWith(prefix)) {
      entry.cancelled = true;
      primeEntries.delete(key);
    }
  }
  try {
    await clearInstanceCache(instanceId);
  } catch {
    // 忽略
  }
};
