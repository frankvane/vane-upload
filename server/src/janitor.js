const fs = require("fs");
const path = require("path");
const { TMP_UPLOAD_DIR } = require("./config/paths");

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
 * 覆盖：上传中断残留、chunkSize 变更后旧键分片（instantCheck reset）、
 * 合并失败后的半成品分片等 DB 已无有效引用的场景（P1-13b）。
 *
 * @returns {Promise<string[]>} 被删除的文件名列表
 */
const sweepOrphanChunks = async ({
  dir = TMP_UPLOAD_DIR,
  ttlMs = DEFAULT_TTL_HOURS * 60 * 60 * 1000,
  now = Date.now(),
} = {}) => {
  const removed = [];

  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    if (!entry.isFile() || PROTECTED_FILES.has(entry.name)) {
      continue;
    }

    const filePath = path.join(dir, entry.name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (now - stat.mtimeMs > ttlMs) {
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
 * 启动 janitor：立即执行一次扫描，之后每 intervalHours 执行一次。
 * @returns {() => void} stop 函数
 */
const startOrphanChunkJanitor = ({
  ttlHours,
  intervalHours,
  logger = console,
} = {}) => {
  const ttlMs =
    toPositiveNumber(ttlHours ?? process.env.TMP_TTL_HOURS, DEFAULT_TTL_HOURS) *
    60 *
    60 *
    1000;
  const intervalMs =
    toPositiveNumber(
      intervalHours ?? process.env.JANITOR_INTERVAL_HOURS,
      DEFAULT_INTERVAL_HOURS,
    ) *
    60 *
    60 *
    1000;

  let stopped = false;

  const run = async () => {
    try {
      const removed = await sweepOrphanChunks({ ttlMs });
      if (removed.length > 0 && typeof logger.log === "function") {
        logger.log(`[janitor] removed ${removed.length} orphan chunk file(s)`);
      }
    } catch (error) {
      if (typeof logger.error === "function") {
        logger.error("[janitor] sweep failed", error);
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
  startOrphanChunkJanitor,
  DEFAULT_TTL_HOURS,
  DEFAULT_INTERVAL_HOURS,
};
