// 本轮修复的回归：VU-10/32（multer 错误映射）、VU-29（严格 DTO 校验）、
// VU-35（/status 的 md5 假校验）、VU-36（队列健康可观测）、VU-31（统一错误处理）。
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rui-hardening2-"));
process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "demo";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.DB_STORAGE = path.join(testRoot, "db.sqlite");
process.env.SERVER_TMP_UPLOAD_DIR = path.join(testRoot, "tmp");
process.env.SERVER_UPLOADS_DIR = path.join(testRoot, "uploads");
process.env.CHUNK_MAX_SIZE_MB = "0.001"; // ≈1048 字节，便于触发 LIMIT_FILE_SIZE
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";

const app = require("../src/app");
const { errorHandler } = require("../src/app");
const { syncModels, sequelize } = require("../src/models");
const { ensureBaseDirs } = require("../src/config/paths");
const { getQueueHealth } = require("../src/services/chunkStateQueue");

const uploadChunk = (fileId, index, buffer, extraFields = 0) => {
  let req = request(app)
    .post("/api/file/upload")
    .field("file_id", fileId)
    .field("index", String(index));
  for (let i = 0; i < extraFields; i += 1) {
    req = req.field(`extra_${i}`, "x");
  }
  return req.attach("chunk", buffer, { filename: "chunk.bin" });
};

test.before(async () => {
  ensureBaseDirs();
  await syncModels({ force: true });
});

test.after(async () => {
  await sequelize.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("VU-10/32：分片超限返回结构化 413，而不是 500", async () => {
  const res = await uploadChunk("oversize", 0, Buffer.alloc(4096, 1));
  assert.equal(res.status, 413);
  assert.equal(res.body.code, 413);
  assert.equal(typeof res.body.message, "string");
  assert.equal(res.body.data.code, "LIMIT_FILE_SIZE");
});

test("VU-32：multipart 字段数量超限返回 400", async () => {
  const res = await uploadChunk("too-many-fields", 0, Buffer.from("x"), 20);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 400);
});

test("VU-29：index 非整数字符串被拒绝，不再静默截断", async () => {
  for (const badIndex of ["1.9", "12abc", "-1", "99999999999999999999"]) {
    const res = await request(app)
      .post("/api/file/upload")
      .field("file_id", "strict-index")
      .field("index", badIndex)
      .attach("chunk", Buffer.from("x"), { filename: "chunk.bin" });
    assert.equal(res.status, 400, `index=${badIndex} 应被拒绝`);
  }
});

test("VU-29：size / total / hash_mode / category_id 的类型与取值被校验", async () => {
  const badInstant = await request(app).post("/api/file/instant").send({
    file_id: "strict-instant",
    md5: "a".repeat(32),
    name: "x.bin",
    size: "3abc",
  });
  assert.equal(badInstant.status, 400);

  const badMerge = await request(app).post("/api/file/merge").send({
    file_id: "strict-merge",
    md5: "a".repeat(32),
    name: "x.bin",
    size: 3,
    total: 1,
    hash_mode: "bypass",
  });
  assert.equal(badMerge.status, 400);
  assert.match(badMerge.body.message, /hash_mode/);

  const badCategory = await request(app).post("/api/file/merge").send({
    file_id: "strict-merge",
    md5: "a".repeat(32),
    name: "x.bin",
    size: 3,
    total: 1,
    category_id: { evil: true },
  });
  assert.equal(badCategory.status, 400);
});

test("VU-35：/status 不再要求一个从不参与查询的 md5", async () => {
  const res = await request(app)
    .get("/api/file/status")
    .query({ file_id: "status-no-md5" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.chunks, []);
});

test("VU-36：队列健康信息可被 /api/health 观测", async () => {
  const health = await request(app).get("/api/health");
  assert.equal(health.status, 200);
  assert.ok(health.body.data.chunkQueue, "health 应暴露 chunkQueue");
  assert.equal(typeof health.body.data.chunkQueue.pending, "number");
  assert.equal(typeof health.body.data.chunkQueue.degraded, "boolean");
  assert.equal(getQueueHealth().degraded, false);
});

test("VU-31：错误中间件按 statusCode / MulterError 映射，而非一律 500", () => {
  const makeRes = () => ({
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  });

  const notFound = makeRes();
  const httpErr = new Error("bad request");
  httpErr.statusCode = 400;
  errorHandler(httpErr, {}, notFound, () => {});
  assert.equal(notFound.statusCode, 400);
  assert.equal(notFound.body.code, 400);

  const multerErr = makeRes();
  const err = new Error("File too large");
  err.name = "MulterError";
  err.code = "LIMIT_FILE_SIZE";
  errorHandler(err, {}, multerErr, () => {});
  assert.equal(multerErr.statusCode, 413);
  assert.equal(multerErr.body.data.code, "LIMIT_FILE_SIZE");
});
