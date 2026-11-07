const fs = require("fs");
const path = require("path");
const { File, FileChunk, sequelize } = require("../models");
const { TMP_UPLOAD_DIR, UPLOADS_DIR, ensureDir } = require("../config/paths");
const { md5Buffer, md5File } = require("../utils/hash");
const {
  sanitizeFileId,
  parseChunkKey,
  sanitizeFilename,
  buildChunkPath,
  isValidMd5,
  resolveInsideBase,
} = require("../utils/fileSecurity");
const { generateThumbnail } = require("../utils/thumbnail");
const { redactErrorMessage } = require("../utils/errorMessage");
const {
  enqueueChunkState,
  flushFileChunkStates,
  getPendingChunkStates,
  dropPendingChunkIndexes,
} = require("../services/chunkStateQueue");
const {
  isSqliteBusyError,
  withSqliteBusyRetry,
} = require("../utils/sqliteRetry");

// P2-9：身份只认鉴权中间件写入的 req.user，绝不读取请求体 user_id。
// 未经过鉴权的调用（仅 demo / 单测直调控制器）回退到历史默认用户 "test"。
const getUserId = (req) =>
  req && req.user && req.user.id ? String(req.user.id) : "test";

const jsonError = (res, statusCode, message, data = {}) =>
  res.status(statusCode).json({ code: statusCode, message, data });

const jsonOk = (res, data = {}) => res.json({ code: 200, message: "ok", data });

const httpError = (statusCode, message, details = undefined) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
};

/**
 * P2-9：秒传 / 已合并只回传调用方真正需要的字段。
 * 此前直接序列化 Sequelize 实例，把 file_path、user_id、thumbnail_path 等
 * 内部信息一并透出；且查询不带 user 维度，形成跨租户信息泄漏面。
 */
const toPublicFile = (file) => {
  if (!file) {
    return null;
  }
  const plain = typeof file.toJSON === "function" ? file.toJSON() : { ...file };
  // 落库值是 `<userId>:<chunkKey>`（保证 file_id 全局唯一），对外仍回传客户端使用的 chunkKey。
  const rawFileId = String(plain.file_id || "");
  const separator = rawFileId.indexOf(":");
  return {
    file_id: separator >= 0 ? rawFileId.slice(separator + 1) : rawFileId,
    file_name: plain.file_name,
    size: plain.size,
    md5: plain.md5,
    file_ext: plain.file_ext,
    file_type: plain.file_type,
    category_id: plain.category_id,
    created_at: plain.created_at,
  };
};

// S3 容量 / 分片数上限（DoS 防护）：请求时读取，支持运行时配置且不受模块缓存影响。
// 默认 5GB 单文件上限、10 万片上限；可通过环境变量收紧。
const getMaxUploadSizeBytes = () => {
  const mb = Number.parseFloat(process.env.MAX_UPLOAD_SIZE_MB || "");
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 5120 * 1024 * 1024;
};

const getMaxChunks = () => {
  const n = Number.parseInt(process.env.MAX_CHUNKS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 100000;
};

// P1-4（残留）：上面两个上限都是「单 file_id」维度，换一个 file_id 就能继续写盘。
// 再加一层进程级全局上限（TMP 目录内所有分片之和），默认 20GB / 20 万片，
// 可用 MAX_TOTAL_UPLOAD_SIZE_MB / MAX_TOTAL_CHUNKS 收紧。全局额度不是租户隔离，
// 但能把「无限占盘」收敛成有界写入。
const getMaxTotalUploadSizeBytes = () => {
  const mb = Number.parseFloat(process.env.MAX_TOTAL_UPLOAD_SIZE_MB || "");
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 20480 * 1024 * 1024;
};

const getMaxTotalChunks = () => {
  const n = Number.parseInt(process.env.MAX_TOTAL_CHUNKS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 200000;
};

// P1-4（user 维度）：按调用方身份累计的配额。
// 单 file_id 上限防单文件超限，全局上限防止进程被写满；用户维度阻止
// 同一凭据通过不断更换 file_id 无限占用存储。
const getMaxUserUploadSizeBytes = () => {
  const mb = Number.parseFloat(process.env.MAX_USER_UPLOAD_SIZE_MB || "");
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 10240 * 1024 * 1024;
};

const getMaxUserChunks = () => {
  const n = Number.parseInt(process.env.MAX_USER_CHUNKS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 100000;
};

// P1-4：分片写入阶段的累计配额。
// 此前 MAX_UPLOAD_SIZE_MB / MAX_CHUNKS 只在 merge 校验，只要不调 merge，
// 就能对同一 file_id（甚至任意 file_id）无限写分片把磁盘占满。
// 这里按 file_id 维护累计占用：首次访问从磁盘播种，之后按增量维护；
// 合并 / 重置分片后显式失效，避免重启或清理后残留陈旧计数。
const chunkUsage = new Map(); // fileId -> { bytes, count }
const CHUNK_USAGE_MAX_TRACKED = 10000;

// P1-4（残留）：全局用量。首次访问（或分片被删除后失效）从磁盘播种，
// 之后按写入增量维护；进程内单线程，无并发写竞争。
const globalChunkUsage = { bytes: 0, count: 0, seeded: false };

const seedGlobalChunkUsage = async () => {
  ensureDir(TMP_UPLOAD_DIR);
  const entries = await fs.promises.readdir(TMP_UPLOAD_DIR);
  let bytes = 0;
  let count = 0;
  for (const name of entries) {
    // 分片文件名固定为 `<fileId>_<index>`；合并 staging（`*.part`）不计入。
    if (!/_\d+$/.test(name)) continue;
    const stat = await fs.promises
      .stat(path.join(TMP_UPLOAD_DIR, name))
      .catch(() => null);
    if (!stat || !stat.isFile()) continue;
    bytes += stat.size;
    count += 1;
  }
  globalChunkUsage.bytes = bytes;
  globalChunkUsage.count = count;
  globalChunkUsage.seeded = true;
  return globalChunkUsage;
};

const getGlobalChunkUsage = async () =>
  globalChunkUsage.seeded ? globalChunkUsage : seedGlobalChunkUsage();

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const seedChunkUsage = async (fileId) => {
  ensureDir(TMP_UPLOAD_DIR);
  const pattern = new RegExp(`^${escapeRegExp(fileId)}_\\d+$`);
  const entries = await fs.promises.readdir(TMP_UPLOAD_DIR);
  let bytes = 0;
  let count = 0;
  for (const name of entries) {
    if (!pattern.test(name)) continue;
    const stat = await fs.promises
      .stat(path.join(TMP_UPLOAD_DIR, name))
      .catch(() => null);
    if (!stat || !stat.isFile()) continue;
    bytes += stat.size;
    count += 1;
  }
  return { bytes, count };
};

const getChunkUsage = async (fileId) => {
  const cached = chunkUsage.get(fileId);
  if (cached) {
    return cached;
  }
  const usage = await seedChunkUsage(fileId);
  if (chunkUsage.size >= CHUNK_USAGE_MAX_TRACKED) {
    chunkUsage.clear();
  }
  chunkUsage.set(fileId, usage);
  return usage;
};

/** 分片被删除 / 合并 / 重置后调用，下次访问重新从磁盘播种。 */
const forgetChunkUsage = (fileId) => {
  chunkUsage.delete(fileId);
  // 分片已从磁盘消失，全局用量同样失效，下次重新播种（P1-4 残留）
  globalChunkUsage.seeded = false;
};

// P1-4（user 维度）：按用户累计。首次访问从 FileChunk + 磁盘播种，
// 合并 / 重置后失效，下次重新播种。
const userChunkUsage = new Map(); // userId -> { bytes, count }
const USER_CHUNK_USAGE_MAX_TRACKED = 10000;

const seedUserChunkUsage = async (userId) => {
  const rows = await withSqliteBusyRetry(() =>
    FileChunk.findAll({
      where: { user_id: userId, status: 1 },
      attributes: ["file_id", "chunk_index"],
    })
  );
  let bytes = 0;
  let count = 0;
  for (const row of rows) {
    const stat = await fs.promises
      .stat(buildChunkPath(row.file_id, row.chunk_index))
      .catch(() => null);
    if (!stat || !stat.isFile()) continue;
    bytes += stat.size;
    count += 1;
  }
  return { bytes, count };
};

const getUserChunkUsage = async (userId) => {
  const cached = userChunkUsage.get(userId);
  if (cached) {
    return cached;
  }
  const usage = await seedUserChunkUsage(userId);
  if (userChunkUsage.size >= USER_CHUNK_USAGE_MAX_TRACKED) {
    userChunkUsage.clear();
  }
  userChunkUsage.set(userId, usage);
  return usage;
};

const forgetUserChunkUsage = (userId) => {
  userChunkUsage.delete(userId);
};

const mergeLocks = new Map();

const acquireMergeLock = (mergeKey) => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  mergeLocks.set(mergeKey, { promise, release });
  return () => {
    const current = mergeLocks.get(mergeKey);
    if (current) {
      mergeLocks.delete(mergeKey);
      current.release();
    }
  };
};

const detectFileType = async (filePath) => {
  try {
    const { fileTypeFromFile } = await import("file-type");
    return await fileTypeFromFile(filePath);
  } catch {
    return null;
  }
};

const buildStoredFileName = (safeFileId, md5, safeName) => {
  const ext = path.extname(safeName);
  if (!ext) {
    return `${safeFileId}_${md5}`;
  }
  return `${safeFileId}_${md5}${ext}`;
};

const buildThumbnailName = (storedFileName) => {
  const ext = path.extname(storedFileName);
  if (!ext) {
    return `${storedFileName}_thumb`;
  }
  const base = storedFileName.slice(0, -ext.length);
  return `${base}_thumb${ext}`;
};

const reconcileChunksWithDisk = async (fileId, chunks) => {
  const availableChunks = [];
  const staleChunkIndexes = [];

  for (const chunk of chunks) {
    const chunkPath = buildChunkPath(fileId, chunk.chunk_index);
    if (fs.existsSync(chunkPath)) {
      availableChunks.push(chunk);
    } else {
      staleChunkIndexes.push(chunk.chunk_index);
    }
  }

  if (staleChunkIndexes.length > 0) {
    await withSqliteBusyRetry(() =>
      FileChunk.update(
        { status: 0 },
        {
          where: {
            file_id: fileId,
            status: 1,
            chunk_index: staleChunkIndexes,
          },
        }
      )
    );
    dropPendingChunkIndexes(fileId, staleChunkIndexes);
  }

  return availableChunks;
};

const buildChunkMap = (fileId, dbChunks) => {
  const chunkMap = new Map(dbChunks.map((chunk) => [chunk.chunk_index, chunk]));
  const pendingChunks = getPendingChunkStates(fileId);

  for (const chunk of pendingChunks) {
    if (chunk.status !== 1) {
      continue;
    }
    const chunkPath = buildChunkPath(fileId, chunk.chunk_index);
    if (!fs.existsSync(chunkPath)) {
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

  const dbChunks = await withSqliteBusyRetry(() =>
    FileChunk.findAll({
      where: { file_id: fileId, status: 1 },
    })
  );

  const staleChunkIndexes = [];
  for (const chunk of dbChunks) {
    const chunkPath = buildChunkPath(fileId, chunk.chunk_index);
    if (fs.existsSync(chunkPath)) {
      await fs.promises.unlink(chunkPath).catch(() => undefined);
    }
    staleChunkIndexes.push(chunk.chunk_index);
  }

  if (staleChunkIndexes.length > 0) {
    await withSqliteBusyRetry(() =>
      FileChunk.update(
        { status: 0 },
        {
          where: {
            file_id: fileId,
            status: 1,
            chunk_index: staleChunkIndexes,
          },
        }
      )
    );
    dropPendingChunkIndexes(fileId, staleChunkIndexes);
  }

  // 分片文件已从磁盘删除，累计用量缓存立即失效（P1-4）
  forgetChunkUsage(fileId);
  if (userId) {
    forgetUserChunkUsage(userId);
  }

  return staleChunkIndexes.length;
};

exports.instantCheck = async (req, res) => {
  try {
    const { file_id, md5, name, size, chunk_md5s, chunk_size } = req.body;
    const safeFileId = sanitizeFileId(file_id);

    if (!safeFileId || !md5 || !name || !size) {
      return jsonError(res, 400, "missing required parameters");
    }

    // 复合分片键（${md5}_${size}_${chunkSize}）与请求参数不一致时，
    // 说明 chunkSize/size 已变更（如网络自适应降级），旧分片不可复用，
    // 清空旧结果让客户端按新分片方案重传（P1-6）。
    const parsedKey = parseChunkKey(safeFileId);
    if (
      parsedKey &&
      (parsedKey.size !== Number(size) ||
        (chunk_size !== undefined && parsedKey.chunkSize !== Number(chunk_size)))
    ) {
      const cleared = await resetChunkResults(safeFileId, getUserId(req));
      return jsonOk(res, {
        uploaded: false,
        chunkCheckResult: [],
        reset: true,
        clearedChunks: cleared,
      });
    }

    // 秒传判定按 md5+size：file_id 含 chunkSize 会随网络自适应变化，
    // 不能作为秒传键（P1-6/P1-7）。
    // P2-9：必须叠加 user_id，否则任意用户都能探测/复用他人已上传的文件。
    const file = await File.findOne({
      where: { md5, size, status: 1, user_id: getUserId(req) },
    });

    if (file) {
      return jsonOk(res, { uploaded: true, file: toPublicFile(file) });
    }

    let chunkCheckResult = [];
    if (Array.isArray(chunk_md5s) && chunk_md5s.length > 0) {
      const dbChunks = await withSqliteBusyRetry(() =>
        FileChunk.findAll({
          where: { file_id: safeFileId, status: 1 },
        })
      );
      const chunks = await reconcileChunksWithDisk(safeFileId, dbChunks);
      const chunkMap = buildChunkMap(safeFileId, chunks);
      chunkCheckResult = chunk_md5s.map((chunkMd5, idx) => {
        const chunk = chunkMap.get(idx);
        return {
          index: idx,
          exist: Boolean(chunk),
          match: chunk ? chunk.chunk_md5 === chunkMd5 : false,
        };
      });
    }

    return jsonOk(res, { uploaded: false, chunkCheckResult });
  } catch (error) {
    if (isSqliteBusyError(error)) {
      return jsonError(res, 503, "database is busy, please retry later");
    }
    return jsonError(res, 500, redactErrorMessage(error));
  }
};

exports.statusQuery = async (req, res) => {
  try {
    const { file_id, md5 } = req.query;
    const safeFileId = sanitizeFileId(file_id);

    if (!safeFileId || !md5) {
      return jsonError(res, 400, "missing required parameters");
    }

    const dbChunks = await withSqliteBusyRetry(() =>
      FileChunk.findAll({
        where: { file_id: safeFileId, status: 1 },
        order: [["chunk_index", "ASC"]],
      })
    );
    const chunks = await reconcileChunksWithDisk(safeFileId, dbChunks);
    const chunkMap = buildChunkMap(safeFileId, chunks);
    const chunkIndexes = Array.from(chunkMap.keys()).sort((a, b) => a - b);

    return jsonOk(res, {
      chunks: chunkIndexes,
    });
  } catch (error) {
    if (isSqliteBusyError(error)) {
      return jsonError(res, 503, "database is busy, please retry later");
    }
    return jsonError(res, 500, redactErrorMessage(error));
  }
};

exports.uploadChunk = async (req, res) => {
  try {
    let { file_id, index, chunk_md5 } = req.body;
    const safeFileId = sanitizeFileId(file_id);

    if (!safeFileId || index === undefined) {
      return jsonError(res, 400, "missing required parameters");
    }
    if (!req.file || !req.file.buffer) {
      return jsonError(res, 400, "missing chunk file");
    }

    index = Number.parseInt(index, 10);
    if (Number.isNaN(index)) {
      return jsonError(res, 400, "index must be an integer");
    }
    if (index < 0 || index >= getMaxChunks()) {
      return jsonError(res, 400, "index out of range");
    }

    ensureDir(TMP_UPLOAD_DIR);
    const chunkPath = buildChunkPath(safeFileId, index);
    const chunkMd5 = md5Buffer(req.file.buffer);
    if (chunk_md5 && chunk_md5 !== chunkMd5) {
      return jsonError(res, 400, "chunk md5 mismatch", {
        index,
        expected: chunk_md5,
        actual: chunkMd5,
      });
    }

    // P1-4：写入前做累计配额校验（单文件累计字节 + 分片数）。
    // 覆盖重传同一 index（按差额计算），避免覆盖写被重复计费。
    const usage = await getChunkUsage(safeFileId);
    const existingChunk = await fs.promises.stat(chunkPath).catch(() => null);
    const replacedBytes =
      existingChunk && existingChunk.isFile() ? existingChunk.size : 0;
    const nextBytes = usage.bytes - replacedBytes + req.file.buffer.length;
    const nextCount = usage.count + (existingChunk ? 0 : 1);
    if (nextBytes > getMaxUploadSizeBytes()) {
      return jsonError(res, 413, "file size exceeds maximum allowed", {
        maxMb: Math.round(getMaxUploadSizeBytes() / 1024 / 1024),
      });
    }
    if (nextCount > getMaxChunks()) {
      return jsonError(res, 400, "total exceeds maximum allowed chunks", {
        max: getMaxChunks(),
      });
    }

    // P1-4（残留）：全局维度校验——换 file_id 也不能突破进程级总容量。
    const globalUsage = await getGlobalChunkUsage();
    const nextGlobalBytes = globalUsage.bytes - replacedBytes + req.file.buffer.length;
    const nextGlobalCount = globalUsage.count + (existingChunk ? 0 : 1);
    if (nextGlobalBytes > getMaxTotalUploadSizeBytes()) {
      return jsonError(res, 413, "storage quota exceeded", {
        maxMb: Math.round(getMaxTotalUploadSizeBytes() / 1024 / 1024),
      });
    }
    if (nextGlobalCount > getMaxTotalChunks()) {
      return jsonError(res, 400, "storage chunks quota exceeded", {
        max: getMaxTotalChunks(),
      });
    }

    // P1-4（user 维度）：同一凭据不断更换 file_id 也不能无限占用存储。
    // 覆盖写只按差额计费；若该分片此前不计入本用户，则按新增计。
    const userId = getUserId(req);
    const userUsage = await getUserChunkUsage(userId);
    const replacedCounted =
      Boolean(existingChunk) && userUsage.bytes >= replacedBytes;
    const nextUserBytes =
      userUsage.bytes -
      (replacedCounted ? replacedBytes : 0) +
      req.file.buffer.length;
    const nextUserCount = userUsage.count + (replacedCounted ? 0 : 1);
    if (nextUserBytes > getMaxUserUploadSizeBytes()) {
      return jsonError(res, 413, "user storage quota exceeded", {
        maxMb: Math.round(getMaxUserUploadSizeBytes() / 1024 / 1024),
      });
    }
    if (nextUserCount > getMaxUserChunks()) {
      return jsonError(res, 400, "user chunks quota exceeded", {
        max: getMaxUserChunks(),
      });
    }

    await fs.promises.writeFile(chunkPath, req.file.buffer);
    usage.bytes = nextBytes;
    usage.count = nextCount;
    globalUsage.bytes = nextGlobalBytes;
    globalUsage.count = nextGlobalCount;
    userUsage.bytes = nextUserBytes;
    userUsage.count = nextUserCount;

    enqueueChunkState({
      file_id: safeFileId,
      chunk_index: index,
      status: 1,
      user_id: getUserId(req),
      upload_time: new Date(),
      chunk_md5: chunk_md5 || chunkMd5,
    });

    return jsonOk(res);
  } catch (error) {
    if (isSqliteBusyError(error)) {
      return jsonError(res, 503, "database is busy, please retry later");
    }
    return jsonError(res, 500, redactErrorMessage(error));
  }
};

// P1-2：合并产物先落在 staging 文件，校验通过后再原子移入 UPLOADS_DIR。
// 同卷时 rename 为原子操作；跨卷（SERVER_TMP_UPLOAD_DIR / SERVER_UPLOADS_DIR 分处不同设备）
// 时退化为 copy + unlink，仍然是「先完整再出现」。
const moveIntoPlace = async (from, to) => {
  try {
    await fs.promises.rename(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }
    await fs.promises.copyFile(from, to);
    await fs.promises.unlink(from).catch(() => undefined);
  }
};

exports.mergeChunks = async (req, res) => {
  let transaction = null;
  let targetPath = "";
  let stagingPath = "";
  let mergeFileId = "";
  let userId = "";
  let releaseMergeLock = () => undefined;

  try {
    ensureDir(TMP_UPLOAD_DIR);
    ensureDir(UPLOADS_DIR);

    const { file_id, md5, name, size, total, category_id, hash_mode } =
      req.body;
    // P2-9：归属由服务端鉴权决定，忽略请求体里的 user_id（防越权写入）。
    userId = getUserId(req);
    // P2-9：file 行的 file_id 加用户命名空间。
    // 表结构仍保持 file_id 全局唯一（不重建已有 SQLite 表），
    // 同一内容被不同用户上传时得到两条互不覆盖的归属记录。
    const fileRowId = `${userId}:${sanitizeFileId(file_id)}`;
    const safeFileId = sanitizeFileId(file_id);
    mergeFileId = safeFileId;
    const safeName = sanitizeFilename(name);

    if (!safeFileId || !safeName || !size || !total) {
      return jsonError(res, 400, "missing required parameters");
    }
    // P0-2：md5 会参与落盘文件名拼接，必须强制为 32 位十六进制，
    // 否则 "../" 等字符可让 path.join 逃出 UPLOADS_DIR。
    if (!isValidMd5(md5)) {
      return jsonError(res, 400, "invalid md5");
    }

    const totalChunks = Number.parseInt(total, 10);
    if (Number.isNaN(totalChunks) || totalChunks <= 0) {
      return jsonError(res, 400, "total must be a positive integer");
    }

    const fileSize = Number(size);
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      return jsonError(res, 400, "size must be a positive number");
    }
    // S3 容量 / 分片数上限（DoS 防护）
    if (totalChunks > getMaxChunks()) {
      return jsonError(res, 400, "total exceeds maximum allowed chunks", {
        max: getMaxChunks(),
      });
    }
    if (fileSize > getMaxUploadSizeBytes()) {
      return jsonError(res, 413, "file size exceeds maximum allowed", {
        maxMb: Math.round(getMaxUploadSizeBytes() / 1024 / 1024),
      });
    }

    const mergeKey = `${safeFileId}:${md5}`;
    const inFlight = mergeLocks.get(mergeKey);
    if (inFlight) {
      await inFlight.promise;
      const mergedFile = await withSqliteBusyRetry(() =>
        File.findOne({
          where: { md5, size, status: 1, user_id: userId },
        })
      );
      if (mergedFile) {
        return jsonOk(res, { alreadyMerged: true, file: toPublicFile(mergedFile) });
      }
      return jsonError(res, 503, "file is being merged, please retry later");
    }
    releaseMergeLock = acquireMergeLock(mergeKey);

    await flushFileChunkStates(safeFileId);

    // 秒传/已合并检查从事务内移到事务外：与 DB 的交互保持短事务，
    // 避免大文件合并的 readFile/appendFile/md5File IO 长时间持锁
    // 导致并发合并触发 SQLITE_BUSY（P1-13a）。
    const existingFile = await withSqliteBusyRetry(() =>
      File.findOne({
        where: { md5, size, status: 1, user_id: userId },
      })
    );
    if (existingFile) {
      return jsonOk(res, { alreadyMerged: true, file: toPublicFile(existingFile) });
    }

    const dbChunks = await withSqliteBusyRetry(() =>
      FileChunk.findAll({
        where: { file_id: safeFileId, status: 1 },
      })
    );
    const chunkMap = new Map(dbChunks.map((chunk) => [chunk.chunk_index, chunk]));

    const storedFileName = buildStoredFileName(safeFileId, md5, safeName);
    // 落盘前再做一次目录约束断言：即使上游校验被绕过，也不允许写/删 UPLOADS_DIR 之外的文件。
    targetPath = resolveInsideBase(UPLOADS_DIR, storedFileName);
    // P1-2：合并写 staging（tmp 目录）而非直接写 UPLOADS_DIR。
    // 后续读取 UPLOADS_DIR 的接口会直接读取文件内容，
    // 直接写目标路径会让并发读取到 0 字节或半成品文件。
    stagingPath = resolveInsideBase(
      TMP_UPLOAD_DIR,
      `${storedFileName}.${safeFileId}.part`
    );
    await fs.promises.writeFile(stagingPath, Buffer.alloc(0));

    for (let i = 0; i < totalChunks; i += 1) {
      const chunkPath = buildChunkPath(safeFileId, i);
      if (!fs.existsSync(chunkPath)) {
        throw httpError(400, `chunk ${i} not found`);
      }

      const chunkBuffer = await fs.promises.readFile(chunkPath);
      const chunkMd5 = md5Buffer(chunkBuffer);
      const dbChunk = chunkMap.get(i);

      if (!dbChunk) {
        throw httpError(400, `chunk ${i} not found in database`);
      }
      if (dbChunk.chunk_md5 && dbChunk.chunk_md5 !== chunkMd5) {
        throw httpError(409, `chunk ${i} md5 does not match database`, {
          index: i,
          db_md5: dbChunk.chunk_md5,
          real_md5: chunkMd5,
        });
      }

      await fs.promises.appendFile(stagingPath, chunkBuffer);
      await fs.promises.unlink(chunkPath);
    }

    // S2 数据完整性：以服务端计算的真实全量 md5 为权威去重键，杜绝 sample 哈希碰撞污染。
    // 1) 先校验合并后文件体积与声明一致（防截断 / 夹带）；
    // 2) full 模式：客户端声明的 md5 应为真实全量哈希，必须一致；
    // 3) sample 模式：跳过"声明 md5"比对（客户端传入的是采样哈希，必然不匹配），
    //    但仍以真实全量 md5 落库，使秒传 / 去重键始终基于强哈希。
    const mergedStat = await fs.promises.stat(stagingPath);
    if (mergedStat.size !== fileSize) {
      throw httpError(422, "file size verification failed", {
        expected: fileSize,
        actual: mergedStat.size,
      });
    }
    const authoritativeMd5 = await md5File(stagingPath);
    if (hash_mode !== "sample") {
      if (authoritativeMd5 !== md5) {
        throw httpError(422, "file md5 verification failed", {
          expected: md5,
          actual: authoritativeMd5,
        });
      }
    }

    // 校验全部通过后才让文件出现在 UPLOADS_DIR，杜绝列表/下载读到中间态。
    await moveIntoPlace(stagingPath, targetPath);
    stagingPath = "";

    const fileTypeResult = await detectFileType(targetPath);
    const fileExt = fileTypeResult?.ext || path.extname(safeName).replace(".", "");
    const fileType = fileTypeResult?.mime || null;
    const filePath = path.posix.join("uploads", storedFileName);

    let thumbnailPath = null;
    if (fileType && fileType.startsWith("image/")) {
      const thumbName = buildThumbnailName(storedFileName);
      const thumbAbsolutePath = path.join(UPLOADS_DIR, thumbName);
      try {
        await generateThumbnail(targetPath, thumbAbsolutePath, {
          width: 200,
          height: 200,
        });
        thumbnailPath = path.posix.join("uploads", thumbName);
      } catch {
        thumbnailPath = null;
      }
    }

    // 重 IO 全部完成后再开短事务写库：File upsert + 分片状态归档一次提交
    transaction = await sequelize.transaction();
    try {
      // P2-9：file_id 已按用户命名空间隔离，不能再直接 upsert 客户端传入的 chunkKey；
      // 改为「按用户命名空间查后更新 / 新建」。
      const fileValues = {
        file_id: fileRowId,
        file_name: safeName,
        size,
        user_id: userId,
        status: 1,
        md5: authoritativeMd5,
        category_id: category_id || 1,
        file_ext: fileExt,
        file_type: fileType,
        file_path: filePath,
        thumbnail_path: thumbnailPath,
      };
      await withSqliteBusyRetry(async () => {
        const owned = await File.findOne({
          where: { file_id: fileRowId, user_id: userId },
          transaction,
        });
        if (owned) {
          await owned.update(fileValues, { transaction });
        } else {
          await File.create(fileValues, { transaction });
        }
      });

      await withSqliteBusyRetry(() =>
        FileChunk.update(
          { status: 2 },
          { where: { file_id: safeFileId }, transaction }
        )
      );

      await transaction.commit();
      transaction = null;
    } catch (dbError) {
      if (transaction && !transaction.finished) {
        await transaction.rollback();
        transaction = null;
      }
      throw dbError;
    }

    return jsonOk(res);
  } catch (error) {
    if (transaction && !transaction.finished) {
      await transaction.rollback();
    }

    if (targetPath && fs.existsSync(targetPath)) {
      await fs.promises.unlink(targetPath).catch(() => undefined);
    }
    if (stagingPath && fs.existsSync(stagingPath)) {
      await fs.promises.unlink(stagingPath).catch(() => undefined);
    }

    const statusCode = isSqliteBusyError(error)
      ? 503
      : Number.isInteger(error.statusCode)
      ? error.statusCode
      : 500;
    // P2-10：业务错误（4xx，由 httpError 显式抛出）保留原文便于客户端定位；
    // 5xx / 未预期错误一律走脱敏，避免 SQL、绝对路径等内部细节外泄。
    const message = isSqliteBusyError(error)
      ? "database is busy, please retry later"
      : statusCode < 500
      ? error.message
      : redactErrorMessage(error);
    return jsonError(res, statusCode, message, error.details || {});
  } finally {
    // 合并会逐片删除源分片，累计用量缓存必须失效（P1-4）
    if (mergeFileId) {
      forgetChunkUsage(mergeFileId);
    }
    if (userId) {
      forgetUserChunkUsage(userId);
    }
    releaseMergeLock();
  }
};
