const app = require("./app");
const { ensureBaseDirs } = require("./config/paths");
const { syncModels } = require("./models");
const { startOrphanChunkJanitor } = require("./janitor");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);

const bootstrap = async () => {
  ensureBaseDirs();
  await syncModels();

  // 孤儿分片清理：启动时执行一次，之后每 6h 扫描
  // （TMP_TTL_HOURS 默认 24h，JANITOR_INTERVAL_HOURS 默认 6h）
  const stopJanitor = startOrphanChunkJanitor();

  const server = app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });

  server.on("close", () => stopJanitor());
  return server;
};

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error("[server] failed to start", error);
    process.exit(1);
  });
}

module.exports = {
  bootstrap,
};
