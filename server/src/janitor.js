const fs = require("fs");
const path = require("path");
const { TMP_UPLOAD_DIR, UPLOADS_DIR } = require("./config/paths");
const { config } = require("./config");
const { logger } = require("./utils/logger");

const DEFAULT_TTL_HOURS = 24;
const DEFAULT_INTERVAL_HOURS = 6;

// 环境变量缺失时 Number(undefined) 为 NaN，需显式回退，否则 setInterval(NaN) 会被压成 1ms
const toPositiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// 受保护文件：目录占位文件不应被清理
const PROTECTED_FILES = new Set([".gitkeep"]);

/**
 * 扫描 tmp/upload，删除修改时间超过 TTL 的孤儿分片文件。
 * 覆盖：上传中断残留、chunkSize 变更后不再被引用的旧键分片（instantCheck reset）、
 * 合并失败后的半成品分片等 DB 已无有效引用的场景。
 *
 * @param {object} [options]
 * @param {string} [options.dir]
 * @param {number} [options.ttlMs]
 * @param {number} [options.now]
 * @param {() => Set<string>|null} [options.getProtectedFileIds]
 *   返回「当前受保护、不得被清理」的 storageId 集合（如正在合并的文件）。
 *   分片文件名固定为 `<storageId>_<index>`，提取 storageId 后若命中该集合则跳过，
 *   避免合并进行中误删源分片导致合并失败。返回 null/undefined 表示不保护。
 * @returns {Promise<string[]>} 被删除的文件名列表
 */
const sweepOrphanChunks = async ({
  dir = TMP_UPLOAD_DIR,
  ttlMs = DEFAULT_TTL_HOURS * 60 * 60 * 1000,
  now = Date.now(),
  getProtectedFileIds,
} = {}) => {
  const removed = [];
  const protectedIds =
    typeof getProtectedFileIds === "function" ? getProtectedFileIds() : null;

  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    if (PROTECTED_FILES.has(entry.name)) {
      continue;
    }

    // VU-15：分片名 `<storageId>_<index>`，提取 storageId 与受保护集合比对。
    // 只剥离末尾的 `_<digits>`，保留 storageId 内部的下划线（chunkKey 含多个 _）。
    // T-60：合并 staging 名 `<...>.<storageId>.part`（uploadController.js 525-528）也需纳入
    // 同一套保护——否则长合并 + 极短 TTL 时，正在写入的 staging 会被 TTL 截断。
    // 两类命名都从文件名还原出 storageId 后再与受保护集合比对。
    let fileId;
    const partMatch = entry.name.match(/\.([^.]+)\.part$/);
    if (partMatch) {
      fileId = partMatch[1];
    } else {
      fileId = entry.name.replace(/_\d+$/, "");
    }
    if (protectedIds && protectedIds.has(fileId)) {
      continue;
    }

    const filePath = path.join(dir, entry.name);
    try {
      // VU-34：用 lstat 而非 stat。旧实现 `entry.isFile()` 对 symlink 返回
      // false 直接跳过，攻击者在 tmp 里留的软链永远不会被清理；
      // 而 stat 会跟随链接读到「目录外目标」的 mtime，可能误判。
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        continue;
      }
      if (now - stat.mtimeMs > ttlMs) {
        // unlink 对 symlink 只删链接本身，不会动目标文件。
        await fs.promises.unlink(filePath);
        removed.push(entry.name);
      }
    } catch {
      // 文件已被并发删除/无权限：跳过即可
    }
  }

  return removed;
};

/**
 * 对账 uploads/ 目录：清理「崩溃窗口」产生的孤儿落盘文件。
 *
 * 场景：合并在 moveIntoPlace 写入 uploads/ 之后、DB 事务提交之前若进程崩溃，
 * 会留下一个「磁盘有文件、DB 无 File 行」的孤儿；此外用户删除文件后其落盘文件
 * 也可能残留（由删除接口清源分片，但不一定清 uploads/ 行——取决于实现）。
 *
 * 与分片 janitor 一致：用 TTL 兜底，避免误删「刚 moveIntoPlace 但尚未提交」的文件。
 * 关键保护：
 *  - `getProtectedFileIds`（= getMergingStorageIds）覆盖「正在合并」的 storageId：
 *    合并进行中 moveIntoPlace 已把文件放进 uploads/，但事务尚未提交，必须跳过；
 *  - `getKnownFileNames` 覆盖「已有 File.status:1 行」的文件基名，已落库的不删。
 *
 * 落盘文件名形如 buildStoredFileName(storageId, md5, safeName) =
 * `${storageId}_${md5}` 或 `${storageId}_${md5}${ext}`，md5 恒为末尾 32 位十六进制，
 * 据此把 storageId 还原出来与受保护集合比对。非 vane 命名的文件（如未知残留）
 * 不擅自删除。
 *
 * @param {object} [options]
 * @param {string} [options.dir]
 * @param {number} [options.ttlMs]
 * @param {number} [options.now]
 * @param {() => Set<string>|null} [options.getProtectedFileIds] 正在合并的 storageId 集合
 * @param {() => Set<string>|null} [options.getKnownFileNames] 已落库文件的基名集合
 * @returns {Promise<string[]>} 被删除的文件名列表
 */
const sweepOrphanUploads = async ({
  dir = UPLOADS_DIR,
  ttlMs = DEFAULT_TTL_HOURS * 60 * 60 * 1000,
  now = Date.now(),
  getProtectedFileIds,
  getKnownFileNames,
} = {}) => {
  const removed = [];
  // 回调可能同步返回 Set，也可能异步（如查询 DB 取已落库文件基名）；await 对两者都安全。
  const protectedIds =
    typeof getProtectedFileIds === "function" ? await getProtectedFileIds() : null;
  const known =
    typeof getKnownFileNames === "function" ? await getKnownFileNames() : null;

  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    if (PROTECTED_FILES.has(entry.name)) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    let stat;
    try {
      // VU-34：lstat 不跟随符号链接，软链只删自身、不碰目标。
      stat = await fs.promises.lstat(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      continue;
    }

    // 还原 storageId：末尾 `_<32hex>` 之前的部分（md5 是唯一确定的 32 位十六进制段）。
    const match = entry.name.match(/^(.*)_([a-f0-9]{32})(\.[^.]*)?$/i);
    if (!match) {
      // 非 vane 落盘命名：不擅自删除，交给人工或其他策略。
      continue;
    }
    const storageId = match[1];
    if (protectedIds && protectedIds.has(storageId)) {
      continue; // 正在合并，事务未提交，跳过
    }
    if (known && known.has(entry.name)) {
      continue; // 已有对应 File.status:1 行
    }
    if (now - stat.mtimeMs > ttlMs) {
      await fs.promises.unlink(filePath).catch(() => undefined);
      removed.push(entry.name);
    }
  }

  return removed;
};

/**
 * 启动 janitor：立即执行一次扫描，之后每 intervalHours 执行一次。
 * @returns {() => void} stop 函数
 */
const startOrphanChunkJanitor = ({
  ttlHours,
  intervalHours,
  logger: injectedLogger,
  protectFileIds,
  dir,
  uploadsDir,
  getUploadFileNames,
} = {}) => {
  const log = injectedLogger || logger;
  // VU-55：默认值由 config 统一提供，不再散落环境变量读取。
  const ttlMs =
    toPositiveNumber(ttlHours ?? config.tmpTtlHours(), DEFAULT_TTL_HOURS) *
    60 *
    60 *
    1000;
  const intervalMs =
    toPositiveNumber(
      intervalHours ?? config.janitorIntervalHours(),
      DEFAULT_INTERVAL_HOURS,
    ) *
    60 *
    60 *
    1000;
  const sweepDir = dir || TMP_UPLOAD_DIR;
  const uploadsSweepDir = uploadsDir || null;

  let stopped = false;

  const run = async () => {
    try {
      // VU-15：每次扫描重新拉取受保护集合（合并是瞬时状态，复用闭包会读到过期快照）。
      const removed = await sweepOrphanChunks({
        dir: sweepDir,
        ttlMs,
        getProtectedFileIds: protectFileIds,
      });
      if (removed.length > 0 && typeof log.info === "function") {
        log.info(`[janitor] removed ${removed.length} orphan chunk file(s)`);
      } else if (removed.length > 0 && typeof log.log === "function") {
        log.log(`[janitor] removed ${removed.length} orphan chunk file(s)`);
      }

      // P2：uploads/ 孤儿对账（崩溃窗口落盘文件 / 已删除文件的残留落盘）。
      if (uploadsSweepDir) {
        const removedUploads = await sweepOrphanUploads({
          dir: uploadsSweepDir,
          ttlMs,
          getProtectedFileIds: protectFileIds,
          getKnownFileNames: getUploadFileNames,
        });
        if (removedUploads.length > 0 && typeof log.info === "function") {
          log.info(
            `[janitor] removed ${removedUploads.length} orphan upload file(s)`,
          );
        } else if (removedUploads.length > 0 && typeof log.log === "function") {
          log.log(
            `[janitor] removed ${removedUploads.length} orphan upload file(s)`,
          );
        }
      }
    } catch (error) {
      if (typeof log.error === "function") {
        log.error("[janitor] sweep failed", error);
      }
    }
  };

  void run();

  const timer = setInterval(() => {
    if (!stopped) {
      void run();
    }
  }, intervalMs);
  // 不阻止进程退出
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return () => {
    stopped = true;
    clearInterval(timer);
  };
};

module.exports = {
  sweepOrphanChunks,
  sweepOrphanUploads,
  startOrphanChunkJanitor,
  DEFAULT_TTL_HOURS,
  DEFAULT_INTERVAL_HOURS,
};
