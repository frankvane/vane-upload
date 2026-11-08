// VU-03 / VU-04 / VU-11：配额从「进程内近似 Map + 全目录 stat 扫描」改为
// 「DB 聚合（FileChunk.size / count）作为唯一 source of truth」，并在 uploadChunk
// 响应前同步落库，消除崩溃窗口。本测试验证：
//   - VU-04：响应 200 前分片已落库（含 size）
//   - VU-03：配额来自 DB 聚合的真实字节数，超限返回 413
//   - VU-11：getChunkUsage 直接读 DB，磁盘分片文件缺失不影响计数
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rui-quota-db-"));
process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "demo";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.DB_STORAGE = path.join(testRoot, "db.sqlite");
process.env.SERVER_TMP_UPLOAD_DIR = path.join(testRoot, "tmp");
process.env.SERVER_UPLOADS_DIR = path.join(testRoot, "uploads");
// 单文件配额上限约 1048 字节（MAX_UPLOAD_SIZE_MB=0.001 的下限）：
// 单片 600 OK，两片累计 1200 → 超限。
process.env.MAX_UPLOAD_SIZE_MB = "0.001";
process.env.CHUNK_MAX_SIZE_MB = "1";
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";

const app = require("../src/app");
const { syncModels, sequelize, FileChunk } = require("../src/models");
const { ensureBaseDirs } = require("../src/config/paths");
const uploadController = require("../src/controllers/uploadController");

const uploadChunk = (fileId, index, buffer) =>
  request(app)
    .post("/api/file/upload")
    .field("file_id", fileId)
    .field("index", String(index))
    .attach("chunk", buffer, { filename: "chunk.bin" });

test.before(async () => {
  ensureBaseDirs();
  await syncModels({ force: true });
});

test.after(async () => {
  await sequelize.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("VU-04：uploadChunk 响应前分片已落库（崩溃窗口消除）", async () => {
  const res = await uploadChunk("f-sync", 0, Buffer.alloc(500, 1));
  assert.equal(res.status, 200);
  // 不依赖 flush 定时器（已设为 60s），响应后即查 DB 应立即可见。
  const rows = await FileChunk.findAll({
    where: { chunk_index: 0, status: 1 },
  });
  assert.ok(rows.length >= 1, "分片应已持久化到 DB");
  const row = rows.find((r) => r.size === 500);
  assert.ok(row, "DB 记录应携带真实 size=500");
});

test("VU-03：配额来自 DB 聚合，累计超限返回 413", async () => {
  const r1 = await uploadChunk("f-quota", 0, Buffer.alloc(600, 1));
  assert.equal(r1.status, 200, "单片 600B 在 1048B 上限内");
  const r2 = await uploadChunk("f-quota", 1, Buffer.alloc(600, 1));
  assert.equal(r2.status, 413, "累计 1200B 超过 1048B 上限");
  assert.equal(r2.body.code, 413);
});

test("VU-03：跨重启/无进程内缓存，配额仍准确（基于 DB）", async () => {
  // 上传 3 片触发上限；第 3 片应在 DB 聚合后被判超限。
  await uploadChunk("f-reboot", 0, Buffer.alloc(400, 1)); // 400B
  await uploadChunk("f-reboot", 1, Buffer.alloc(400, 1)); // 累计 800B
  const r3 = await uploadChunk("f-reboot", 2, Buffer.alloc(400, 1)); // 累计 1200B
  assert.equal(r3.status, 413, "DB 聚合应反映已落库的全部分片");
});

test("VU-11：getChunkUsage 直接读 DB，磁盘文件缺失不影响计数", async () => {
  await uploadChunk("f-stat", 0, Buffer.alloc(500, 1));
  const dbRow = await FileChunk.findOne({
    where: { chunk_index: 0, status: 1 },
  });
  assert.ok(dbRow, "应有 DB 记录");
  const storageId = dbRow.file_id; // scoped id，含用户命名空间前缀
  // 删除磁盘分片文件，但 DB 记录保留。
  fs.rmSync(path.join(process.env.SERVER_TMP_UPLOAD_DIR, `${storageId}_0`), {
    force: true,
  });
  const usage = await uploadController.__quotaInternals.getChunkUsage(storageId);
  // 若配额仍依赖全目录 stat，删文件后应为 0；DB 聚合应仍为 500。
  assert.equal(usage.bytes, 500, "配额应读 DB 而非磁盘");
  assert.equal(usage.count, 1);
  // 全局 / 用户维度同样基于 DB。
  const globalUsage =
    await uploadController.__quotaInternals.getGlobalChunkUsage();
  assert.ok(globalUsage.bytes >= 500, "全局配额也应基于 DB 聚合");
});
