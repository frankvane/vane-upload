const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

process.env.NODE_ENV = "test";
const testDbStorage = path.join(__dirname, "tmp-test-chunk-key.sqlite");
process.env.DB_STORAGE = testDbStorage;
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";
// 功能测试需要开放的服务端，显式关闭鉴权（默认 AUTH_MODE=secure 会 fail-closed）
process.env.AUTH_MODE = "demo";
// 显式关闭限流，避免与其他测试文件的全局 env 相互覆盖导致偶发 429
process.env.RATE_LIMIT_ENABLED = "false";

const app = require("../src/app");
const { syncModels, sequelize, File, FileChunk } = require("../src/models");
const { TMP_UPLOAD_DIR, UPLOADS_DIR, ensureBaseDirs } = require("../src/config/paths");
const { md5Buffer } = require("../src/utils/hash");
const { buildChunkPath } = require("../src/utils/fileSecurity");
const { resetChunkStateQueueForTests } = require("../src/services/chunkStateQueue");

// 与客户端 src/shared/chunkKey.ts 保持一致
const buildChunkKey = (md5, size, chunkSize) => `${md5}_${size}_${chunkSize}`;

const uploadChunk = async (fileId, index, buffer) => {
  const res = await request(app)
    .post("/api/file/upload")
    .field("file_id", fileId)
    .field("index", String(index))
    .field("chunk_md5", md5Buffer(buffer))
    .attach("chunk", buffer, { filename: `chunk-${index}.bin` });
  assert.equal(res.status, 200);
  return res;
};

const mergeFile = async (fileId, md5, name, size, total) => {
  const res = await request(app).post("/api/file/merge").send({
    file_id: fileId,
    md5,
    name,
    size,
    total,
  });
  return res;
};

test.before(async () => {
  ensureBaseDirs();
  if (fs.existsSync(testDbStorage)) fs.unlinkSync(testDbStorage);
  await syncModels({ force: true });
});

test.beforeEach(async () => {
  await resetChunkStateQueueForTests();
});

test.after(async () => {
  await resetChunkStateQueueForTests();
  await sequelize.close();

  for (const dir of [TMP_UPLOAD_DIR, UPLOADS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, name));
    }
  }
  if (fs.existsSync(testDbStorage)) fs.unlinkSync(testDbStorage);
});

test("同一文件不同 chunkSize 的两轮上传互不污染，均能合并成功（P1-6）", async () => {
  // 8 字节内容，第一轮 chunkSize=4（2 片），第二轮 chunkSize=8（1 片）
  const content = Buffer.from("ABCDEFGH", "utf8");
  const md5 = md5Buffer(content);
  const size = content.length;

  const keyBig = buildChunkKey(md5, size, 4);
  const keySmall = buildChunkKey(md5, size, 8);

  // 第一轮：按 chunkSize=4 上传 2 片（不合并，模拟传一半）
  await uploadChunk(keyBig, 0, content.subarray(0, 4));
  await uploadChunk(keyBig, 1, content.subarray(4, 8));

  // 第二轮：chunkSize 变为 8，instantCheck 应看不到第一轮的分片
  const instantRes = await request(app).post("/api/file/instant").send({
    file_id: keySmall,
    md5,
    name: "decoupled.bin",
    size,
    chunk_size: 8,
    chunk_md5s: [md5],
  });
  assert.equal(instantRes.status, 200);
  assert.equal(instantRes.body.data.uploaded, false);
  assert.deepEqual(instantRes.body.data.chunkCheckResult, [
    { index: 0, exist: false, match: false },
  ]);

  // 第二轮按新分片方案上传并合并
  await uploadChunk(keySmall, 0, content);
  const mergeSmall = await mergeFile(keySmall, md5, "decoupled.bin", size, 1);
  assert.equal(mergeSmall.status, 200);
  assert.equal(mergeSmall.body.code, 200);

  // 第一轮的分片仍然完好、未被第二轮污染（键隔离，孤儿分片由 janitor 兜底清理）
  assert.equal(fs.existsSync(buildChunkPath(keyBig, 0)), true);
  assert.equal(fs.existsSync(buildChunkPath(keyBig, 1)), true);

  // 第一轮再合并：同 md5+size 秒传复用，返回 alreadyMerged（不再重复落盘）
  const mergeBig = await mergeFile(keyBig, md5, "decoupled.bin", size, 2);
  assert.equal(mergeBig.status, 200);
  assert.equal(mergeBig.body.data.alreadyMerged, true);

  // File 表按 md5+size 唯一（秒传语义）
  const files = await File.findAll({ where: { md5, size, status: 1 } });
  assert.equal(files.length, 1);

  const absolute = path.join(__dirname, "..", files[0].file_path);
  const buffer = fs.readFileSync(absolute);
  assert.equal(md5Buffer(buffer), md5);
  assert.equal(buffer.length, size);

  // 第二轮的分片文件已随合并清理
  assert.equal(fs.existsSync(buildChunkPath(keySmall, 0)), false);
});

test("秒传按 md5+size 判定：chunkSize 变化不影响秒传命中（P1-6/P1-7）", async () => {
  const content = Buffer.from("instant-key-payload", "utf8");
  const md5 = md5Buffer(content);
  const size = content.length;

  const firstKey = buildChunkKey(md5, size, 1024);
  await uploadChunk(firstKey, 0, content);
  const mergeRes = await mergeFile(firstKey, md5, "instant-key.bin", size, 1);
  assert.equal(mergeRes.status, 200);

  // 同一文件换一个 chunkSize 再问秒传：按 md5+size 命中
  const secondKey = buildChunkKey(md5, size, 4096);
  const instantRes = await request(app).post("/api/file/instant").send({
    file_id: secondKey,
    md5,
    name: "instant-key.bin",
    size,
    chunk_size: 4096,
    chunk_md5s: [md5],
  });
  assert.equal(instantRes.status, 200);
  assert.equal(instantRes.body.data.uploaded, true);
  assert.equal(instantRes.body.data.file.md5, md5);
});

test("复合键与请求参数不一致时清空旧分片结果（P1-6）", async () => {
  const content = Buffer.from("reset-case-payload", "utf8");
  const md5 = md5Buffer(content);
  const size = content.length;
  const key = buildChunkKey(md5, size, 2048);

  await uploadChunk(key, 0, content);
  assert.equal(fs.existsSync(buildChunkPath(key, 0)), true);

  // 请求体 size 与键内 size 不符 → 旧分片被清空
  const instantRes = await request(app).post("/api/file/instant").send({
    file_id: key,
    md5,
    name: "reset-case.bin",
    size: size + 1,
    chunk_md5s: [md5],
  });
  assert.equal(instantRes.status, 200);
  assert.equal(instantRes.body.data.reset, true);
  assert.equal(instantRes.body.data.clearedChunks, 1);
  assert.equal(fs.existsSync(buildChunkPath(key, 0)), false);

  const remaining = await FileChunk.count({ where: { file_id: key, status: 1 } });
  assert.equal(remaining, 0);

  // 请求体 chunk_size 与键内 chunkSize 不符 → 同样清空
  await uploadChunk(key, 0, content);
  const instantRes2 = await request(app).post("/api/file/instant").send({
    file_id: key,
    md5,
    name: "reset-case.bin",
    size,
    chunk_size: 512,
    chunk_md5s: [md5],
  });
  assert.equal(instantRes2.status, 200);
  assert.equal(instantRes2.body.data.reset, true);
  assert.equal(fs.existsSync(buildChunkPath(key, 0)), false);
});

test("旧版纯 md5 键保持兼容（不走一致性清空逻辑）", async () => {
  const content = Buffer.from("legacy-key-payload", "utf8");
  const md5 = md5Buffer(content);

  // 旧客户端：file_id 直接传 md5
  const instantRes = await request(app).post("/api/file/instant").send({
    file_id: md5,
    md5,
    name: "legacy.bin",
    size: content.length,
    chunk_md5s: [md5],
  });
  assert.equal(instantRes.status, 200);
  assert.equal(instantRes.body.data.uploaded, false);
  assert.equal(instantRes.body.data.reset, undefined);

  await uploadChunk(md5, 0, content);
  const statusRes = await request(app)
    .get("/api/file/status")
    .query({ file_id: md5, md5 });
  assert.equal(statusRes.status, 200);
  assert.deepEqual(statusRes.body.data.chunks, [0]);

  const mergeRes = await mergeFile(md5, md5, "legacy.bin", content.length, 1);
  assert.equal(mergeRes.status, 200);
});
