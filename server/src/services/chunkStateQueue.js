const { FileChunk } = require("../models");
const { withSqliteBusyRetry } = require("../utils/sqliteRetry");

const DEFAULT_BATCH_SIZE = Number.parseInt(
  process.env.CHUNK_STATE_BATCH_SIZE || "40",
  10
);
const DEFAULT_FLUSH_INTERVAL_MS = Number.parseInt(
  process.env.CHUNK_STATE_FLUSH_INTERVAL_MS || "180",
  10
);
const DEFAULT_MAX_PENDING = Number.parseInt(
  process.env.CHUNK_STATE_MAX_PENDING || "120",
  10
);

const UPDATE_ON_DUPLICATE_FIELDS = [
  "status",
  "user_id",
  "upload_time",
  "chunk_md5",
];

const pendingByFile = new Map();
let flushTimer = null;
let writeQueue = Promise.resolve();

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

const scheduleFlush = () => {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPendingChunkStates().catch(() => {
      scheduleFlush();
    });
  }, FLUSH_INTERVAL_MS);
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
    void flushPendingChunkStates().catch(() => {
      scheduleFlush();
    });
    return;
  }
  scheduleFlush();
};

const flushPendingChunkStates = async () =>
  runExclusive(async () => {
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
  await runExclusive(async () => undefined);
};

module.exports = {
  enqueueChunkState,
  flushPendingChunkStates,
  flushFileChunkStates,
  getPendingChunkStates,
  dropPendingChunkIndexes,
  resetChunkStateQueueForTests,
};
