const app = require("./app");
const { ensureBaseDirs } = require("./config/paths");
const { config, validateStartupConfig } = require("./config");
const { syncModels, sequelize } = require("./models");
const { startOrphanChunkJanitor } = require("./janitor");
const { getMergingStorageIds } = require("./controllers/uploadController");
const { flushPendingChunkStates } = require("./services/chunkStateQueue");
const { logger } = require("./utils/logger");

const PORT = config.port();
const SHUTDOWN_TIMEOUT_MS = config.shutdownTimeoutMs();

let server = null;
let stopJanitor = null;
let shuttingDown = false;

const bootstrap = async ({ skipConfigValidation = false } = {}) => {
  ensureBaseDirs();
  // VU-55：生产部署缺凭据 / 目录不可写时启动即失败，而不是等第一个请求。
  // 单测通过 require("./index") 调 bootstrap 时显式跳过，避免误报。
  if (!skipConfigValidation && !config.isDevOrTest()) {
    const check = validateStartupConfig();
    if (!check.ok) {
      const error = new Error(
        `[FATAL] invalid startup config:\n - ${check.errors.join("\n - ")}`
      );
      logger.error(error);
      throw error;
    }
  }
  await syncModels();

  // 孤儿分片清理：启动时执行一次，之后每 6h 扫描
  // （TMP_TTL_HOURS 默认 24h，JANITOR_INTERVAL_HOURS 默认 6h）
  // VU-15：传入受保护集合——正在合并的文件其源分片不得被清理，避免合并中途丢片。
  stopJanitor = startOrphanChunkJanitor({
    protectFileIds: () => getMergingStorageIds(),
  });

  server = app.listen(PORT, () => {
    logger.info(`[server] listening on http://localhost:${PORT}`);
  });

  server.on("close", () => stopJanitor?.());
  return server;
};

/**
 * VU-27：正常停服（SIGTERM / 容器滚动更新）也必须先把内存中的分片状态刷进 DB。
 * 刷盘定时器是 unref 的，进程退出时不会等待它，pending 状态必然丢失，
 * 重启后「磁盘有分片、DB 无行」，用户只能全量重传。
 */
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[server] ${signal} received, draining...`);

  const forceExit = setTimeout(() => {
    logger.error("[server] shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref?.();

  let exitCode = 0;
  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    stopJanitor?.();
    await flushPendingChunkStates();
    await sequelize.close();
    logger.info("[server] shutdown complete");
  } catch (error) {
    exitCode = 1;
    logger.error("[server] shutdown failed", error);
  } finally {
    clearTimeout(forceExit);
    process.exit(exitCode);
  }
};

if (require.main === module) {
  bootstrap()
    .then(() => {
      for (const signal of ["SIGTERM", "SIGINT"]) {
        process.once(signal, () => void shutdown(signal));
      }
    })
    .catch((error) => {
      logger.error("[server] failed to start", error);
      process.exit(1);
    });
}

module.exports = {
  bootstrap,
  shutdown,
};
