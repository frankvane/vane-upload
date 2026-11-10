/**
 * 分片缓存编排层（主线程）：预热、就绪判定、配额/上限降级与清理。
 *
 * 与 {@link ./chunkCacheStore} 分工：store 只做原始 IndexedDB 读写（Worker 也用），
 * 本模块决定「何时缓存、缓存到什么程度、失败如何降级」，并持有同一文件的
 * 预热 Promise —— 文件选择与上传启动可能同时触发预热，必须共享同一次写入。
 *
 * 核心不变量：就绪标记最后写入，因此 `getFileCacheMeta` 有值 ⟹ 全部分片已落盘。
 * 续传判定只看这条标记；标记不存在一律降级为「刷新后需重新选择文件」。
 *
 * 预热不参与上传首字节关键路径：它只服务于刷新后续传，刻意不等它完成；
 * 预热未完成时刷新会在续传判定处降级，不会静默丢数据。
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

/**
 * 单文件缓存上限默认值：不限制（Infinity）。
 *
 * 默认策略改为「按浏览器真实可用空间判断」：只要 quota - usage 的 80%
 * 足以容纳本次待缓存分片，就写入缓存；固定上限仅作为可选保险，供确实
 * 需要限制单文件落盘量的场景显式配置（判定口径同样按待缓存分片字节）。
 */
export const DEFAULT_CHUNK_CACHE_MAX_FILE_SIZE = Number.POSITIVE_INFINITY;
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
/**
 * 空间预检安全余量：待缓存字节不得超过「quota - usage」的 80%（预留 20%）。
 * 相较旧版贴着 90% 配额写入，给浏览器自身与其他数据留出更多缓冲，
 * 避免写到中途触发 QuotaExceededError 才降级。
 */
const QUOTA_HEADROOM_RATIO = 0.2;

export type ChunkCacheStatus =
  | "ready"
  | "skipped"
  /** 浏览器可用空间不足以容纳本次待缓存分片 */
  | "insufficient-space"
  /** IndexedDB 不可用（隐私模式）或写入失败 */
  | "unavailable";

export interface ChunkCacheOptions {
  instanceId: string;
  /**
   * 待缓存分片的字节上限（可选，缺省不限制）。
   * <=0 或 Infinity 表示不限制；判定对象是「尚未确认上传的分片字节」。
   */
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

/**
 * 申请持久化存储（best-effort，只尝试一次）。
 * 成功可显著降低浏览器在空间紧张时驱逐缓存的概率；失败/不支持不影响主流程。
 */
let persistPromise: Promise<boolean> | null = null;
const requestPersistentStorage = (): void => {
  if (persistPromise) {
    return;
  }
  try {
    const storage = typeof navigator !== "undefined" ? navigator.storage : null;
    if (!storage || typeof storage.persist !== "function") {
      // 不缓存“不可用”结果：后续环境具备 persist 时仍可尝试一次
      return;
    }
    persistPromise = Promise.resolve(storage.persist()).catch(() => false);
  } catch {
    // 忽略：隐私模式/权限拒绝时直接继续
  }
};

const resolveChunkSize = (file: UploadFile): number =>
  file.chunkSize && file.chunkSize > 0 ? file.chunkSize : DEFAULT_CHUNK_SIZE;

const resolveChunkCount = (file: UploadFile, chunkSize: number): number =>
  file.chunkCount && file.chunkCount > 0
    ? file.chunkCount
    : Math.ceil(file.fileSize / chunkSize);

/**
 * 本次实际需要缓存的字节数 = 文件大小 - 已确认上传分片字节。
 * 分片级缓存“传完即删”，已确认分片不需要再占空间；这也是空间预检与
 * 上限判断的统一口径（而不是整个文件大小）。
 */
const resolvePendingBytes = (
  file: UploadFile,
  chunkSize: number,
  chunkCount: number
): number => {
  const confirmedChunks = Math.min(
    Math.max(file.uploadedChunks ?? 0, 0),
    chunkCount
  );
  return Math.max(file.fileSize - confirmedChunks * chunkSize, 0);
};

const runPrime = async (
  file: UploadFile,
  fileRef: File,
  options: ChunkCacheOptions,
  entry: PrimeEntry
): Promise<ChunkCacheStatus> => {
  const keys = toKeys(options.instanceId, file.id);
  const maxPendingBytes =
    options.maxFileSize ?? DEFAULT_CHUNK_CACHE_MAX_FILE_SIZE;

  if (!isChunkCacheSupported()) {
    return "unavailable";
  }

  // 尽量申请持久化存储，降低缓存被浏览器驱逐的概率（失败不影响主流程）。
  requestPersistentStorage();

  const chunkSize = resolveChunkSize(file);
  const chunkCount = resolveChunkCount(file, chunkSize);
  const pendingBytes = resolvePendingBytes(file, chunkSize, chunkCount);

  // 可选的固定上限：按「待缓存分片字节」判断，默认不限制。
  if (
    Number.isFinite(maxPendingBytes) &&
    maxPendingBytes > 0 &&
    pendingBytes > maxPendingBytes
  ) {
    return "skipped";
  }

  try {
    // 已就绪（例如同一文件重复触发预热）：直接复用，不重复写。
    if (await getFileCacheMeta(keys)) {
      return "ready";
    }

    // 按真实可用空间判断：待缓存字节不得超过 (quota - usage) 的 80%。
    const quota = await readQuota();
    if (quota && quota.quota > 0) {
      const available = Math.max(quota.quota - quota.usage, 0);
      const cacheable = available * (1 - QUOTA_HEADROOM_RATIO);
      if (pendingBytes > cacheable) {
        return "insufficient-space";
      }
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
 * 判定顺序：IndexedDB 可用性 → 可选固定上限（按待缓存分片字节）→
 * 浏览器可用空间（`quota - usage` 的 80%）→ 实际写入。
 *
 * @returns ready=已完整落盘可刷新续传；skipped=超过显式配置的上限；
 *          insufficient-space=可用空间不足；unavailable=环境不可用或写入失败
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
