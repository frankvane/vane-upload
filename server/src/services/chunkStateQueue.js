const { FileChunk } = require("../models");
const { withSqliteBusyRetry } = require("../utils/sqliteRetry");
const { config } = require("../config");
const { logger } = require("../utils/logger");

// VU-55：env 读取集中到 config；下面仍用 toValidInt 兜住历史非法值语义。
const DEFAULT_BATCH_SIZE = config.chunkStateBatchSize();
const DEFAULT_FLUSH_INTERVAL_MS = config.chunkStateFlushIntervalMs();
const DEFAULT_MAX_PENDING = config.chunkStateMaxPending();

const UPDATE_ON_DUPLICATE_FIELDS = [
  "status",
  "user_id",
  "upload_time",
  "chunk_md5",
  "size",
];

const pendingByFile = new Map();
let flushTimer = null;
let writeQueue = Promise.resolve();

// VU-36：此前 flush 失败被 `.catch(() => scheduleFlush())` 静默吞掉，
// 每 180ms 无限重试且 /api/health 恒 200，真实故障完全不可观测。
let consecutiveFailures = 0;
let lastFlushError = null;
const MAX_BACKOFF_MS = 30 * 1000;
const DEGRADED_AFTER_FAILURES = 5;

const getQueueHealth = () => ({
  pending: getPendingCount(),
  consecutiveFailures,
  degraded: consecutiveFailures >= DEGRADED_AFTER_FAILURES,
  lastError: lastFlushError
    ? String(lastFlushError.message || lastFlushError)
    : null,
});

const toValidInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const BATCH_SIZE = Math.max(1, toValidInt(DEFAULT_BATCH_SIZE, 40));
const FLUSH_INTERVAL_MS = Math.max(10, toValidInt(DEFAULT_FLUSH_INTERVAL_MS, 180));
const MAX_PENDING = Math.max(BATCH_SIZE, toValidInt(DEFAULT_MAX_PENDING, 120));

const getPendingFileMap = (fileId) => {
  let fileMap = pendingByFile.get(fileId);
  if (!fileMap) {
    fileMap = new Map();
    pendingByFile.set(fileId, fileMap);
  }
  return fileMap;
};

const normalizeChunkState = (chunkState) => ({
  file_id: String(chunkState.file_id),
  chunk_index: Number.parseInt(String(chunkState.chunk_index), 10),
  status: Number.parseInt(String(chunkState.status ?? 1), 10),
  user_id: chunkState.user_id || "test",
  upload_time: chunkState.upload_time || new Date(),
  chunk_md5: chunkState.chunk_md5 || null,
  // VU-03/04/11：持久化分片字节数，使配额可直接用 DB 聚合。
  size: Number.isFinite(Number(chunkState.size)) ? Number(chunkState.size) : 0,
});

const getPendingCount = () => {
  let count = 0;
  for (const fileMap of pendingByFile.values()) {
    count += fileMap.size;
  }
  return count;
};

const restorePendingStates = (states) => {
  for (const state of states) {
    const fileMap = getPendingFileMap(state.file_id);
    fileMap.set(state.chunk_index, state);
  }
};

const cleanupFileMap = (fileId) => {
  const fileMap = pendingByFile.get(fileId);
  if (fileMap && fileMap.size === 0) {
    pendingByFile.delete(fileId);
  }
};

const drainPendingStates = ({ fileId, limit = BATCH_SIZE } = {}) => {
  const drained = [];

  const collectFromFileMap = (targetFileId, fileMap) => {
    for (const [chunkIndex, state] of fileMap.entries()) {
      drained.push(state);
      fileMap.delete(chunkIndex);
      if (drained.length >= limit) {
        break;
      }
    }
    cleanupFileMap(targetFileId);
  };

  if (fileId) {
    const fileMap = pendingByFile.get(fileId);
    if (!fileMap) {
      return drained;
    }
    collectFromFileMap(fileId, fileMap);
    return drained;
  }

  for (const [targetFileId, fileMap] of pendingByFile.entries()) {
    collectFromFileMap(targetFileId, fileMap);
    if (drained.length >= limit) {
      break;
    }
  }

  return drained;
};

const persistChunkStates = async (states) => {
  if (states.length === 0) {
    return;
  }
  await withSqliteBusyRetry(() =>
    FileChunk.bulkCreate(states, {
      updateOnDuplicate: UPDATE_ON_DUPLICATE_FIELDS,
    })
  );
};

const handleFlushFailure = (error) => {
  consecutiveFailures += 1;
  lastFlushError = error;
  logger.error("[chunkStateQueue] flush failed", error);
  // 指数退避，避免 DB 持续 BUSY / 磁盘满时以 180ms 频率空转打满 CPU 与 IO。
  const delay = Math.min(
    FLUSH_INTERVAL_MS * 2 ** consecutiveFailures,
    MAX_BACKOFF_MS
  );
  scheduleFlush(delay);
};

const scheduleFlush = (delayMs = FLUSH_INTERVAL_MS) => {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPendingChunkStates().catch(handleFlushFailure);
  }, delayMs);
  // 待刷盘定时器不应成为进程存活的原因（否则 test / 短生命周期脚本要等满间隔才退出）
  flushTimer.unref?.();
};

const runExclusive = async (operation) => {
  const previous = writeQueue;
  let release;
  writeQueue = new Promise((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
};

const enqueueChunkState = (chunkState) => {
  const normalized = normalizeChunkState(chunkState);
  if (Number.isNaN(normalized.chunk_index)) {
    throw new Error("invalid chunk_index for chunk state");
  }

  const fileMap = getPendingFileMap(normalized.file_id);
  fileMap.set(normalized.chunk_index, normalized);

  if (getPendingCount() >= MAX_PENDING) {
    void flushPendingChunkStates().catch(handleFlushFailure);
    return;
  }
  scheduleFlush();
};

const flushPendingChunkStates = async () => {
  const result = await runExclusive(async () => {
    while (true) {
      const batch = drainPendingStates({ limit: BATCH_SIZE });
      if (batch.length === 0) {
        return;
      }
      try {
        await persistChunkStates(batch);
      } catch (error) {
        restorePendingStates(batch);
        throw error;
      }
    }
  });
  consecutiveFailures = 0;
  lastFlushError = null;
  return result;
};

const flushFileChunkStates = async (fileId) => {
  const normalizedFileId = String(fileId || "");
  if (!normalizedFileId) {
    return;
  }
  await runExclusive(async () => {
    while (true) {
      const batch = drainPendingStates({
        fileId: normalizedFileId,
        limit: BATCH_SIZE,
      });
      if (batch.length === 0) {
        return;
      }
      try {
        await persistChunkStates(batch);
      } catch (error) {
        restorePendingStates(batch);
        throw error;
      }
    }
  });
};

const getPendingChunkStates = (fileId) => {
  const normalizedFileId = String(fileId || "");
  if (!normalizedFileId) {
    return [];
  }
  const fileMap = pendingByFile.get(normalizedFileId);
  if (!fileMap) {
    return [];
  }
  return Array.from(fileMap.values());
};

const dropPendingChunkIndexes = (fileId, chunkIndexes) => {
  const normalizedFileId = String(fileId || "");
  if (!normalizedFileId || !Array.isArray(chunkIndexes) || chunkIndexes.length === 0) {
    return;
  }
  const fileMap = pendingByFile.get(normalizedFileId);
  if (!fileMap) {
    return;
  }
  for (const chunkIndex of chunkIndexes) {
    fileMap.delete(chunkIndex);
  }
  cleanupFileMap(normalizedFileId);
};

const resetChunkStateQueueForTests = async () => {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pendingByFile.clear();
  consecutiveFailures = 0;
  lastFlushError = null;
  await runExclusive(async () => undefined);
};

module.exports = {
  enqueueChunkState,
  flushPendingChunkStates,
  flushFileChunkStates,
  getPendingChunkStates,
  dropPendingChunkIndexes,
  getQueueHealth,
  resetChunkStateQueueForTests,
};
