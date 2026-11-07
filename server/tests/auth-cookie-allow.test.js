// 回归测试：P0-3 修复后，配置了 FILE_AUTH_COOKIE_TOKENS 的正常用法仍可放行。
const path = require("path");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "secure";
process.env.FILE_AUTH_COOKIE = "session_id";
process.env.FILE_AUTH_COOKIE_TOKENS = "good-token,second-token";
delete process.env.FILE_AUTH_TOKEN;
process.env.RATE_LIMIT_ENABLED = "false";

const testDbStorage = path.join(__dirname, "tmp-test-auth-cookie-allow.sqlite");
process.env.DB_STORAGE = testDbStorage;
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";

const app = require("../src/app");
const { syncModels, sequelize } = require("../src/models");

test.before(async () => {
  await syncModels({ force: true });
});

test.after(async () => {
  await sequelize.close();
  if (fs.existsSync(testDbStorage)) fs.unlinkSync(testDbStorage);
});

test("Cookie 命中白名单 → 放行（状态接口 200）", async () => {
  const res = await request(app)
    .get("/api/file/status")
    .query({ file_id: "cookie-case", md5: "unused" })
    .set("Cookie", "session_id=good-token");
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 200);
});

test("Cookie 未命中白名单 → 401", async () => {
  const res = await request(app)
    .get("/api/file/status")
    .set("Cookie", "session_id=wrong-token");
  assert.equal(res.status, 401);
});
