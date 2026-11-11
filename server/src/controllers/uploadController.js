const fs = require("fs");
const path = require("path");

const { File, FileChunk, sequelize } = require("../models");
const { TMP_UPLOAD_DIR, UPLOADS_DIR, ensureDir } = require("../config/paths");
const { config } = require("../config");
const { md5Buffer, md5File } = require("../utils/hash");
const {
  sanitizeFileId,
  parseChunkKey,
  sanitizeFilename,
  buildChunkPath,
  isValidMd5,
  resolveInsideBase,
  buildScopedFileId,
  inspectWriteTarget,
  writeRegularFile,
} = require("../utils/fileSecurity");
const { assertSafeFileType } = require("../utils/filePolicy");
const { createMergeLockRegistry } = require("../utils/mergeLock");
const { redactErrorMessage } = require("../utils/errorMessage");
const { parseStrictInt } = require("../utils/validate");
const {
  enqueueChunkState,
  flushFileChunkStates,
  dropPendingChunkIndexes,
  runExclusiveByKey,
} = require("../services/chunkStateQueue");
const {
  isSqliteBusyError,
  withSqliteBusyRetry,
} = require("../utils/sqliteRetry");

// VU-54：抽离的职责模块（单一职责拆分，见 response / quotaService / chunkOperations / mergeIo）
const {
  jsonError,
  jsonOk,
  httpError,
  toPublicFile,
  getUserId,
  getStorageId,
  fileExists,
} = require("./response");
const {
  aggregateChunkUsage,
  getChunkUsage,
  getGlobalChunkUsage,
  getUserChunkUsage,
} = require("../services/quotaService");
const {
  reconcileChunksWithDisk,
  buildChunkMap,
  resetChunkResults,
  buildStoredFileName,
} = require("./chunkOperations");
const { moveIntoPlace } = require("./mergeIo");

// S3 容量 / 分片数上限（DoS 防护）：请求时读取，支持运行时配置且不受模块缓存影响。
// VU-55：默认值与合法性校验统一收敛到 config/index.js。
const getMaxUploadSizeBytes = () => config.maxUploadSizeBytes();
const getMaxChunks = () => config.maxChunks();

// P1-4（残留）：上面两个上限都是「单 file_id」维度，换一个 file_id 就能继续写盘。
// 再加一层进程级全局上限（TMP 目录内所有分片之和），默认 20GB / 20 万片，
// 可用 MAX_TOTAL_UPLOAD_SIZE_MB / MAX_TOTAL_CHUNKS 收紧。全局额度不是租户隔离，
// 但能把「无限占盘」收敛成有界写入。
const getMaxTotalUploadSizeBytes = () => config.maxTotalUploadSizeBytes();
const getMaxTotalChunks = () => config.maxTotalChunks();

// P1-4（user 维度）：按调用方身份累计的配额。
// 单 file_id 上限防单文件超限，全局上限防止进程被写满；用户维度阻止
// 同一凭据通过不断更换 file_id 无限占用存储。
const getMaxUserUploadSizeBytes = () => config.maxUserUploadSizeBytes();
const getMaxUserChunks = () => config.maxUserChunks();

// VU-08：锁的超时 / 等待者上限由独立模块承载（可直接单测）。
const mergeLocks = createMergeLockRegistry({
  waitTimeoutMs: config.mergeWaitTimeoutMs,
  maxWaiters: config.mergeMaxWaiters,
});

// VU-15：提供给 janitor 的「正在合并的文件集合」。合并键形如
// `${userId}:${storageId}:${md5}`，取中间段即为分片落盘所用的 storageId。
// janitor 据此跳过这些文件的孤儿分片，避免合并进行中把源分片清掉导致合并失败。
exports.getMergingStorageIds = () =>
  new Set(mergeLocks.keys().map((key) => key.split(":")[1]));

// VU-03/04/11 测试钩子：暴露配额聚合内部函数，便于断言「配额直接读 DB 而非磁盘」。
// 仅用于单测，不影响生产行为。
exports.__quotaInternals = {
  aggregateChunkUsage,
  getChunkUsage,
  getGlobalChunkUsage,
  getUserChunkUsage,
};


exports.instantCheck = async (req, res) => {
  try {
    const { file_id, md5, name, size, chunk_md5s, chunk_size } = req.body;
    const safeFileId = sanitizeFileId(file_id);

    if (!safeFileId || !md5 || !name || size === undefined) {
      return jsonError(res, 400, "缺少必填参数");
    }
    // VU-29：size 必须是安全非负整数（VU-59 起允许 0，支持真 0 字节文件秒传查询），
    // 否则 SQLite BIGINT 比较会静默不命中秒传。
    const sizeValue = parseStrictInt(size, { min: 0 });
    const chunkSizeValue =
      chunk_size === undefined
        ? null
        : parseStrictInt(chunk_size, { min: 1 });
    if (sizeValue === null || (chunk_size !== undefined && chunkSizeValue === null)) {
      return jsonError(res, 400, "size 与 chunk_size 必须是有效的整数");
    }
    // VU-09：chunk_md5s 是客户端可控的数组，旧实现只查长度不查元素，
    // 单个元素塞进几 MB 字符串照样能在鉴权后吃满内存与 JSON 解析时间。
    // 元素必须是短字符串；非数组直接拒绝，避免后续 `.map` 抛 TypeError 变 500。
    if (chunk_md5s !== undefined && !Array.isArray(chunk_md5s)) {
      return jsonError(res, 400, "chunk_md5s 必须是数组");
    }
    if (Array.isArray(chunk_md5s)) {
      if (chunk_md5s.length > getMaxChunks()) {
        return jsonError(res, 400, "chunk_md5s 的数量超过允许的最大分片数");
      }
      if (
        chunk_md5s.some(
          (value) => typeof value !== "string" || value.length > 64 || /\s/.test(value)
        )
      ) {
        return jsonError(res, 400, "chunk_md5s 中存在非法元素");
      }
    }
    const userId = getUserId(req);
    const storageId = getStorageId(req, safeFileId);

    // 复合分片键（${md5}_${size}_${chunkSize}）与请求参数不一致时，
    // 说明 chunkSize/size 已变更（如网络自适应降级），旧分片不可复用，
    // 清空旧结果让客户端按新分片方案重传（P1-6）。
    const parsedKey = parseChunkKey(safeFileId);
    if (
      parsedKey &&
      (parsedKey.size !== sizeValue ||
        (chunkSizeValue !== null && parsedKey.chunkSize !== chunkSizeValue))
    ) {
      const cleared = await resetChunkResults(storageId, userId);
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
      where: { md5, size: sizeValue, status: 1, user_id: userId },
    });

    if (file) {
      return jsonOk(res, { uploaded: true, file: toPublicFile(file) });
    }

    let chunkCheckResult = [];
    if (Array.isArray(chunk_md5s) && chunk_md5s.length > 0) {
      const dbChunks = await withSqliteBusyRetry(() =>
        FileChunk.findAll({
          where: { file_id: storageId, status: 1, user_id: userId },
          attributes: ["chunk_index", "chunk_md5"],
        })
      );
      const chunks = await reconcileChunksWithDisk(storageId, dbChunks, userId);
      const chunkMap = await buildChunkMap(storageId, chunks);
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
      return jsonError(res, 503, "数据库繁忙，请稍后重试");
    }
    return jsonError(res, 500, redactErrorMessage(error));
  }
};

exports.statusQuery = async (req, res) => {
  try {
    const { file_id } = req.query;
    const safeFileId = sanitizeFileId(file_id);

    // VU-35：md5 此前被强制必填却从不参与查询，是个假校验；
    // 现在显式忽略它（前端仍会带上，属于无害的多余参数）。
    if (!safeFileId) {
      return jsonError(res, 400, "缺少必填参数");
    }
    const userId = getUserId(req);
    const storageId = getStorageId(req, safeFileId);

    const dbChunks = await withSqliteBusyRetry(() =>
      FileChunk.findAll({
        where: { file_id: storageId, status: 1, user_id: userId },
        attributes: ["chunk_index", "chunk_md5"],
        order: [["chunk_index", "ASC"]],
      })
    );
    const chunks = await reconcileChunksWithDisk(storageId, dbChunks, userId);
    const chunkMap = await buildChunkMap(storageId, chunks);
    const chunkIndexes = Array.from(chunkMap.keys()).sort((a, b) => a - b);

    return jsonOk(res, {
      chunks: chunkIndexes,
    });
  } catch (error) {
    if (isSqliteBusyError(error)) {
      return jsonError(res, 503, "数据库繁忙，请稍后重试");
    }
    return jsonError(res, 500, redactErrorMessage(error));
  }
};

/**
 * E2E-03：删除上传任务时清理服务端残留分片。
 *
 * 客户端删除本地记录后会调用本接口；服务端清空该 file_id 下的分片文件与
 * FileChunk 记录。清理后即使旧客户端仍尝试 /merge，也会因缺少分片而失败，
 * 不会把「已删除」的文件合并落盘。
 */
exports.abortUpload = async (req, res) => {
  try {
    const safeFileId = sanitizeFileId(req.body?.file_id);
    if (!safeFileId) {
      return jsonError(res, 400, "缺少必填参数");
    }
    const userId = getUserId(req);
    const storageId = getStorageId(req, safeFileId);

    // T-38：merge 从 acquire 合并锁到 finally 释放的整个「读片 → 落盘 → 清理 →
    // 落库」周期都登记在 getMergingStorageIds() 中。此时继续清理源分片会与
    // merge 的读片/落盘交叉，造成 ENOENT 或「产物已落盘 + FileChunk 归零」分裂；
    // 命中即明确拒绝，让调用方稍后重试，而不是删到一半。
    if (exports.getMergingStorageIds().has(storageId)) {
      return jsonError(res, 409, "文件正在合并中，请稍后重试");
    }

    const cleared = await resetChunkResults(storageId, userId);
    return jsonOk(res, { cleared });
  } catch (error) {
    if (isSqliteBusyError(error)) {
      return jsonError(res, 503, "数据库繁忙，请稍后重试");
    }
    return jsonError(res, 500, redactErrorMessage(error));
  }
};

exports.uploadChunk = async (req, res) => {
  try {
    const { file_id, index: rawIndex, chunk_md5 } = req.body;
    const safeFileId = sanitizeFileId(file_id);

    if (!safeFileId || rawIndex === undefined) {
      return jsonError(res, 400, "缺少必填参数");
    }
    if (!req.file || !req.file.buffer) {
      return jsonError(res, 400, "缺少分片文件");
    }

    // VU-29：parseInt("1.9"/"12abc") 会静默截断，必须严格校验。
    const index = parseStrictInt(rawIndex, { min: 0, max: getMaxChunks() - 1 });
    if (index === null) {
      return jsonError(res, 400, "index 必须是范围内的整数");
    }
    if (chunk_md5 && typeof chunk_md5 === "string" && !isValidMd5(chunk_md5)) {
      return jsonError(res, 400, "chunk_md5 不合法");
    }

    const userId = getUserId(req);
    const storageId = getStorageId(req, safeFileId);

    ensureDir(TMP_UPLOAD_DIR);
    const chunkPath = buildChunkPath(storageId, index);
    // VU-34：写前用 lstat 拒绝预置的符号链接 / 非普通文件，并在真正写入时用 O_NOFOLLOW 堵住 TOCTOU 窗口。
    await inspectWriteTarget(chunkPath);
    // T-60：配额以 DB 为唯一 source of truth，replacedBytes 不再依赖磁盘 lstat。
    // 磁盘孤儿分片（如 flush 失败残留）与 DB 行不一致会让 nextBytes 算错（含负值），
    // 故改为查 DB 既有行（status:1）的大小作为被覆盖字节。
    const existingDbChunk = await FileChunk.findOne({
      where: { file_id: storageId, chunk_index: index, user_id: userId, status: 1 },
      attributes: ["size"],
    });
    const hasExistingChunk = Boolean(existingDbChunk);
    const replacedBytes = existingDbChunk ? existingDbChunk.size : 0;
    const chunkMd5 = md5Buffer(req.file.buffer);
    if (chunk_md5 && chunk_md5 !== chunkMd5) {
      return jsonError(res, 400, "分片 MD5 校验不匹配", {
        index,
        expected: chunk_md5,
        actual: chunkMd5,
      });
    }

    // T-37：配额的「读 usage → 三级校验 → 写盘 → enqueue → flush」是一次
    // check-then-act。并发请求若各自读到同一份 usage 会全部通过校验，突破
    // file / global / user 三级上限。用全局 key 串行化整个临界区：global 维度
    // 天然全局互斥，user / file 维度也被同一把锁覆盖，且单 key 不会死锁。
    // 校验失败以返回值传回外层统一响应，避免在锁内直接写 res 造成二次响应。
    const rejection = await runExclusiveByKey("upload-quota", async () => {
      // VU-03/04/11：写入前做累计配额校验（单文件累计字节 + 分片数）。
      // 配额直接来自 DB 聚合（FileChunk.size / count），是重启/并发安全的 source of truth，
      // 不再依赖进程内近似 Map，也不再触发全目录 stat 扫描（VU-03 / VU-11）。
      // 覆盖重传同一 index 按差额计费，避免覆盖写被重复计费。
      const usage = await getChunkUsage(storageId);
      const nextBytes = usage.bytes - replacedBytes + req.file.buffer.length;
      const nextCount = usage.count + (hasExistingChunk ? 0 : 1);
      if (nextBytes > getMaxUploadSizeBytes()) {
        return {
          statusCode: 413,
          message: "文件大小超过允许的最大值",
          data: { maxMb: Math.round(getMaxUploadSizeBytes() / 1024 / 1024) },
        };
      }
      if (nextCount > getMaxChunks()) {
        return {
          statusCode: 400,
          message: "total 超过允许的最大分片数",
          data: { max: getMaxChunks() },
        };
      }

      // VU-03（全局维度）：换 file_id 也不能突破进程级总容量。
      const globalUsage = await getGlobalChunkUsage();
      const nextGlobalBytes =
        globalUsage.bytes - replacedBytes + req.file.buffer.length;
      const nextGlobalCount = globalUsage.count + (hasExistingChunk ? 0 : 1);
      if (nextGlobalBytes > getMaxTotalUploadSizeBytes()) {
        return {
          statusCode: 413,
          message: "存储配额已用尽",
          data: { maxMb: Math.round(getMaxTotalUploadSizeBytes() / 1024 / 1024) },
        };
      }
      if (nextGlobalCount > getMaxTotalChunks()) {
        return {
          statusCode: 400,
          message: "分片存储配额已用尽",
          data: { max: getMaxTotalChunks() },
        };
      }

      // VU-03（user 维度）：同一凭据不断更换 file_id 也不能无限占用存储。
      // 覆盖写只按差额计费；若该分片此前不计入本用户，则按新增计。
      const userUsage = await getUserChunkUsage(userId);
      const replacedCounted =
        Boolean(hasExistingChunk) && userUsage.bytes >= replacedBytes;
      const nextUserBytes =
        userUsage.bytes -
        (replacedCounted ? replacedBytes : 0) +
        req.file.buffer.length;
      const nextUserCount = userUsage.count + (replacedCounted ? 0 : 1);
      if (nextUserBytes > getMaxUserUploadSizeBytes()) {
        return {
          statusCode: 413,
          message: "用户存储配额已用尽",
          data: { maxMb: Math.round(getMaxUserUploadSizeBytes() / 1024 / 1024) },
        };
      }
      if (nextUserCount > getMaxUserChunks()) {
        return {
          statusCode: 400,
          message: "用户分片配额已用尽",
          data: { max: getMaxUserChunks() },
        };
      }

      // 写盘 + 落库同步化（VU-04）：先写磁盘，再 enqueue 含 size 的状态，
      // 然后强制 flush 本 file 的 pending，确保响应 200 前该分片已持久化到 DB。
      // 这消除了「磁盘已写、DB 未落」的崩溃窗口，使后续配额查询基于准确的 DB 聚合。
      await writeRegularFile(chunkPath, req.file.buffer);
      enqueueChunkState({
        file_id: storageId,
        chunk_index: index,
        status: 1,
        size: req.file.buffer.length,
        user_id: userId,
        upload_time: new Date(),
        chunk_md5: chunk_md5 || chunkMd5,
      });
      try {
        await flushFileChunkStates(storageId);
      } catch (flushError) {
        // T-60：落库失败（如 SQLITE_BUSY）→ 磁盘分片成了无 DB 状态的孤儿。
        // flushFileChunkStates 失败时会把 pending 放回队列等待重试，故先撤销本分片的
        // pending（dropPendingChunkIndexes），再清理磁盘分片，保持「磁盘 / DB / pending」
        // 三者一致——否则会留下「DB 有行、磁盘无文件」的反向脏数据，或重传同 index 时
        // nextBytes 因口径不一致算错（含负值）。
        dropPendingChunkIndexes(storageId, [index]);
        await fs.promises.unlink(chunkPath).catch(() => undefined);
        throw flushError;
      }
      return null;
    });
    if (rejection) {
      return jsonError(
        res,
        rejection.statusCode,
        rejection.message,
        rejection.data
      );
    }

    return jsonOk(res);
  } catch (error) {
    if (isSqliteBusyError(error)) {
      return jsonError(res, 503, "数据库繁忙，请稍后重试");
    }
    // VU-34：inspectWriteTarget / writeRegularFile 的 403 必须原样回传，
    // 不能被吞成 500（否则客户端会无意义重试）。
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    const message =
      statusCode < 500 ? error.message : redactErrorMessage(error);
    return jsonError(res, statusCode, message, error.details || {});
  }
};

exports.mergeChunks = async (req, res) => {
  let transaction = null;
  let targetPath = "";
  let stagingPath = "";
  let userId = "";
  let releaseMergeLock = () => undefined;
  // VU-01：只有本请求确实完成过 moveIntoPlace，失败清理才有权删除 targetPath。
  // 否则一次校验失败的合并会删掉同内容其他用户已成功落盘的文件。
  let movedIntoPlace = false;

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
    // VU-01/VU-02：所有分片路径、落盘名、FileChunk 键都带用户命名空间。
    const storageId = buildScopedFileId(userId, safeFileId);
    const safeName = sanitizeFilename(name);

    if (!safeFileId || !safeName || size === undefined || total === undefined) {
      return jsonError(res, 400, "缺少必填参数");
    }
    // P0-2：md5 会参与落盘文件名拼接，必须强制为 32 位十六进制，
    // 否则 "../" 等字符可让 path.join 逃出 UPLOADS_DIR。
    if (!isValidMd5(md5)) {
      return jsonError(res, 400, "md5 不合法");
    }
    // VU-29：hash_mode 是客户端可控的校验强度开关，必须白名单化。
    const hashMode = hash_mode === undefined ? "full" : hash_mode;
    if (hashMode !== "full" && hashMode !== "sample") {
      return jsonError(res, 400, "hash_mode 不合法");
    }
    const categoryId =
      category_id === undefined ? 1 : parseStrictInt(category_id, { min: 1 });
    if (categoryId === null) {
      return jsonError(res, 400, "category_id 不合法");
    }

    const totalChunks = parseStrictInt(total, { min: 1 });
    if (totalChunks === null) {
      return jsonError(res, 400, "total 必须是正整数");
    }

    const fileSize = parseStrictInt(size, { min: 0 });
    if (fileSize === null) {
      return jsonError(res, 400, "size 必须是非负整数");
    }
    // S3 容量 / 分片数上限（DoS 防护）
    if (totalChunks > getMaxChunks()) {
      return jsonError(res, 400, "total 超过允许的最大分片数", {
        max: getMaxChunks(),
      });
    }
    if (fileSize > getMaxUploadSizeBytes()) {
      return jsonError(res, 413, "文件大小超过允许的最大值", {
        maxMb: Math.round(getMaxUploadSizeBytes() / 1024 / 1024),
      });
    }

    // VU-08：mergeKey 已带 userId（不同用户不互相阻塞）；
    // 等待同键合并时加超时与等待者上限，避免无限挂起 / 无界堆积。
    const mergeKey = `${userId}:${storageId}:${md5}`;
    if (await mergeLocks.wait(mergeKey)) {
      const mergedFile = await withSqliteBusyRetry(() =>
        File.findOne({
          where: { md5, size: fileSize, status: 1, user_id: userId },
        })
      );
      if (mergedFile) {
        return jsonOk(res, { alreadyMerged: true, file: toPublicFile(mergedFile) });
      }
      return jsonError(res, 503, "文件正在合并中，请稍后重试");
    }
    releaseMergeLock = mergeLocks.acquire(mergeKey);

    await flushFileChunkStates(storageId);

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
        where: { file_id: storageId, status: 1, user_id: userId },
        attributes: ["chunk_index", "chunk_md5"],
      })
    );
    const chunkMap = new Map(dbChunks.map((chunk) => [chunk.chunk_index, chunk]));

    const storedFileName = buildStoredFileName(storageId, md5, safeName);
    // 落盘前再做一次目录约束断言：即使上游校验被绕过，也不允许写/删 UPLOADS_DIR 之外的文件。
    targetPath = resolveInsideBase(UPLOADS_DIR, storedFileName);
    // P1-2：合并写 staging（tmp 目录）而非直接写 UPLOADS_DIR。
    // 后续读取 UPLOADS_DIR 的接口会直接读取文件内容，
    // 直接写目标路径会让并发读取到 0 字节或半成品文件。
    stagingPath = resolveInsideBase(
      TMP_UPLOAD_DIR,
      `${storedFileName}.${storageId}.part`
    );
    // VU-34：staging 路径同样可能被预置为符号链接（名字可由 storageId 推导）。
    await inspectWriteTarget(stagingPath);
    await writeRegularFile(stagingPath, Buffer.alloc(0));

    for (let i = 0; i < totalChunks; i += 1) {
      const chunkPath = buildChunkPath(storageId, i);
      // VU-34：分片路径可能被预置为符号链接。lstat 拒绝非普通文件，
      // 绝不跟随链接读取/删除目录外文件。
      const chunkStat = await inspectWriteTarget(chunkPath);
      if (!chunkStat) {
        throw httpError(400, `第 ${i} 个分片不存在`);
      }

      const chunkBuffer = await fs.promises.readFile(chunkPath);
      const chunkMd5 = md5Buffer(chunkBuffer);
      const dbChunk = chunkMap.get(i);

      if (!dbChunk) {
        throw httpError(400, `第 ${i} 个分片未落库`);
      }
      if (dbChunk.chunk_md5 && dbChunk.chunk_md5 !== chunkMd5) {
        throw httpError(409, `第 ${i} 个分片的 MD5 与数据库记录不一致`, {
          index: i,
          db_md5: dbChunk.chunk_md5,
          real_md5: chunkMd5,
        });
      }

      await fs.promises.appendFile(stagingPath, chunkBuffer);
      // VU-59：不在循环内删除分片。合并中途失败（缺失分片 / md5 不匹配 / IO 异常）
      // 时必须保留全部已传分片，供客户端断点续传；源分片只在 moveIntoPlace 成功后
      // 才统一清理（见下方）。此前在循环内 unlink，会导致 gap 之前已拼入 staging 的
      // 分片随 staging 回滚被误删，破坏续传友好度。
    }

    // S2 数据完整性 + VU-23：
    // 1) 先校验合并后文件体积与声明一致（防截断 / 夹带）；
    // 2) full 模式：客户端声明的 md5 应为真实全量哈希，必须一致；
    // 3) sample 模式：客户端传的是采样哈希，跳过与权威哈希的比对；
    //    完整性由 size + 逐分片 md5（DB 行校验）保证。
    // 关键：DB 的 md5 必须与 /instant、/merge 的查询键一致，也就是客户端声明值。
    // 旧实现落库 authoritativeMd5 而查询用客户端 md5，导致 sample 模式秒传
    // 100% 失效、storedFileName 与 DB 键口径分裂。sample 模式的采样碰撞风险
    // 是客户端已明示的设计取舍，不应以牺牲秒传能力为代价隐藏它。
    const mergedStat = await fs.promises.stat(stagingPath);
    if (mergedStat.size !== fileSize) {
      throw httpError(422, "文件大小校验未通过", {
        expected: fileSize,
        actual: mergedStat.size,
      });
    }
    const authoritativeMd5 = await md5File(stagingPath);
    if (hashMode !== "sample") {
      if (authoritativeMd5 !== md5) {
        throw httpError(422, "文件 MD5 校验未通过", {
          expected: md5,
          actual: authoritativeMd5,
        });
      }
    }

    // VU-33：类型策略必须在 moveIntoPlace 之前跑，415 时只清 staging，
    // uploads 目录零残留。危险扩展名 / 危险 MIME / 可选白名单都在此拦截。
    const { ext: fileExt, mime: fileType } = await assertSafeFileType({
      filePath: stagingPath,
      fileName: safeName,
    });

    // 校验全部通过后才让文件出现在 UPLOADS_DIR，杜绝列表/下载读到中间态。
    await moveIntoPlace(stagingPath, targetPath);
    movedIntoPlace = true;
    stagingPath = "";

    // VU-59：合并产物已落盘，统一清理已并入产物的源分片。删除必须放在
    // moveIntoPlace 成功之后；本请求若从未 moveIntoPlace（含缺失分片 / md5 不匹配
    // / 磁盘或 DB 异常），循环内未 unlink，所有已传分片原样保留，客户端可续传。
    for (let i = 0; i < totalChunks; i += 1) {
      const chunkPath = buildChunkPath(storageId, i);
      await fs.promises.unlink(chunkPath).catch(() => undefined);
    }

    // VU-14：sharp 从未声明为依赖，缩略图能力永远不可用；
    // 不引入新的重型依赖，改为显式保留空值（列仍兼容历史数据）。
    const thumbnailPath = null;
    const filePath = path.posix.join("uploads", storedFileName);

    // 重 IO 全部完成后再开短事务写库：File upsert + 分片状态归档一次提交
    transaction = await sequelize.transaction();
    try {
      // P2-9：file_id 已按用户命名空间隔离，不能再直接 upsert 客户端传入的 chunkKey；
      // 改为「按用户命名空间查后更新 / 新建」。
      const fileValues = {
        file_id: fileRowId,
        file_name: safeName,
        size: fileSize,
        user_id: userId,
        status: 1,
        md5,
        category_id: categoryId,
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
          {
            where: { file_id: storageId, user_id: userId },
            transaction,
          }
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

    // VU-01：绝不删除「本请求未创建」的目标文件。
    // 事务提交失败等已 moveIntoPlace 的场景才需要回滚物理文件。
    if (movedIntoPlace && targetPath && (await fileExists(targetPath))) {
      await fs.promises.unlink(targetPath).catch(() => undefined);
    }
    if (stagingPath && (await fileExists(stagingPath))) {
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
      ? "数据库繁忙，请稍后重试"
      : statusCode < 500
      ? error.message
      : redactErrorMessage(error);
    return jsonError(res, statusCode, message, error.details || {});
  } finally {
    releaseMergeLock();
  }
};
