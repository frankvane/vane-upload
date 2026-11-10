// VU-09：验证 body parser 挂在鉴权之后，且 JSON 上限收紧后可配置。
// 这是一个独立进程：AUTH_MODE=secure 与 app.js 加载期配置不能和其他文件共享。
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rui-body-order-"));
process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "secure";
process.env.FILE_AUTH_TOKEN = "test-secret-token";
process.env.DB_STORAGE = path.join(testRoot, "db.sqlite");
process.env.SERVER_TMP_UPLOAD_DIR = path.join(testRoot, "tmp");
process.env.SERVER_UPLOADS_DIR = path.join(testRoot, "uploads");
process.env.RATE_LIMIT_ENABLED = "false";
// 约 10KB（config 允许的最小档）：让 64KB 的「超大 body」在解析层必然触发 413，
// 从而区分 401 与 413 的先后顺序。
process.env.JSON_BODY_LIMIT_MB = "0.01";
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";

const app = require("../src/app");
const { syncModels, sequelize } = require("../src/models");
const { ensureBaseDirs } = require("../src/config/paths");

const bigPayload = {
  file_id: "f-body-order",
  md5: "a".repeat(32),
  name: "x.bin",
  size: 3,
  blob: "x".repeat(64 * 1024),
};

const postInstant = (payload, withAuth) => {
  const req = request(app).post("/api/file/instant");
  if (withAuth) req.set("Authorization", "Bearer test-secret-token");
  return req.send(payload);
};

test.before(async () => {
  ensureBaseDirs();
  await syncModels({ force: true });
});

test.after(async () => {
  await sequelize.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("VU-09：未鉴权的超大 JSON 直接 401，不会先解析出 413", async () => {
  const res = await postInstant(bigPayload, false);
  assert.equal(res.status, 401);
  assert.notEqual(res.status, 413);
});

test("VU-09：鉴权通过后，超大 JSON 由 body 上限返回结构化 413", async () => {
  const res = await postInstant(bigPayload, true);
  assert.equal(res.status, 413);
  assert.equal(res.body.code, 413);
  assert.equal(res.body.message, "请求体超过允许的大小");
});

test("VU-09：正常大小的已鉴权请求仍可走通业务链路", async () => {
  const res = await postInstant(
    {
      file_id: "f-body-small",
      md5: "a".repeat(32),
      name: "x.bin",
      size: 3,
    },
    true
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.data.uploaded, false);
});
