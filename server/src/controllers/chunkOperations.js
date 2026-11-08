// VU-54：从 uploadController 抽离的「分片状态重组 / 旧分片重置 / 落盘文件名构建」辅助。

const fs = require("fs");
const path = require("path");
const { FileChunk } = require("../models");
const { buildChunkPath } = require("../utils/fileSecurity");
const {
  flushFileChunkStates,
  getPendingChunkStates,
  dropPendingChunkIndexes,
} = require("../services/chunkStateQueue");
const { withSqliteBusyRetry } = require("../utils/sqliteRetry");
const { fileExists } = require("./response");

// SQLite 绑定变量上限（999 或 32766），IN (...) 必须分批。
const DB_IN_BATCH_SIZE = 500;

const buildStoredFileName = (storageId, md5, safeName) => {
  const ext = path.extname(safeName);
  if (!ext) {
    return `${storageId}_${md5}`;
  }
  return `${storageId}_${md5}${ext}`;
};

const reconcileChunksWithDisk = async (fileId, chunks, userId) => {
  const availableChunks = [];
  const staleChunkIndexes = [];

  for (const chunk of chunks) {
    const chunkPath = buildChunkPath(fileId, chunk.chunk_index);
    if (await fileExists(chunkPath)) {
      availableChunks.push(chunk);
    } else {
      staleChunkIndexes.push(chunk.chunk_index);
    }
  }

  if (staleChunkIndexes.length > 0) {
    // VU-28：SQLite 的绑定变量上限为 999/32766，10 万个索引一次性塞进
    // IN (...) 必抛 "too many SQL variables"。按 500 分批更新。
    for (let i = 0; i < staleChunkIndexes.length; i += DB_IN_BATCH_SIZE) {
      const batch = staleChunkIndexes.slice(i, i + DB_IN_BATCH_SIZE);
      await withSqliteBusyRetry(() =>
        FileChunk.update(
          { status: 0 },
          {
            where: {
              file_id: fileId,
              status: 1,
              chunk_index: batch,
              ...(userId ? { user_id: userId } : {}),
            },
          }
        )
      );
    }
    dropPendingChunkIndexes(fileId, staleChunkIndexes);
  }

  return availableChunks;
};

const buildChunkMap = async (fileId, dbChunks) => {
  const chunkMap = new Map(dbChunks.map((chunk) => [chunk.chunk_index, chunk]));
  const pendingChunks = getPendingChunkStates(fileId);

  for (const chunk of pendingChunks) {
    if (chunk.status !== 1) {
      continue;
    }
    const chunkPath = buildChunkPath(fileId, chunk.chunk_index);
    if (!(await fileExists(chunkPath))) {
      dropPendingChunkIndexes(fileId, [chunk.chunk_index]);
      continue;
    }
    chunkMap.set(chunk.chunk_index, chunk);
  }

  return chunkMap;
};

/**
 * 清空某个分片键下的旧分片结果（FileChunk 置无效 + 删除 tmp 分片文件）。
 * 用于 chunkSize/size 变更后旧分片不再可用的场景（P1-6）。
 */
const resetChunkResults = async (fileId, userId) => {
  // 分片状态经异步队列落库，先把队列刷进 DB 再清理，避免漏删已入队分片
  await flushFileChunkStates(fileId);

  const whereScope = {
    file_id: fileId,
    status: 1,
    ...(userId ? { user_id: userId } : {}),
  };
  const dbChunks = await withSqliteBusyRetry(() =>
    FileChunk.findAll({
      where: whereScope,
      attributes: ["chunk_index"],
    })
  );

  // VU-52：串行 unlink 改为并发；磁盘删除失败不影响后续状态清理。
  await Promise.all(
    dbChunks.map((chunk) =>
      fs.promises
        .unlink(buildChunkPath(fileId, chunk.chunk_index))
        .catch(() => undefined)
    )
  );

  // VU-28：置 0 不需要索引列表，一次 UPDATE 即可，彻底避开 IN (...) 变量上限。
  await withSqliteBusyRetry(() =>
    FileChunk.update({ status: 0 }, { where: whereScope })
  );
  dropPendingChunkIndexes(
    fileId,
    dbChunks.map((chunk) => chunk.chunk_index)
  );

  return dbChunks.length;
};

module.exports = {
  DB_IN_BATCH_SIZE,
  buildStoredFileName,
  reconcileChunksWithDisk,
  buildChunkMap,
  resetChunkResults,
};
