// 回归测试：P0-3 Cookie 鉴权不得「存在即通过」。
// 仅配置 FILE_AUTH_COOKIE（未配置 FILE_AUTH_COOKIE_TOKENS）时，
// 任意非空 Cookie 值都必须 401 —— 否则攻击者可伪造一个 Cookie 绕过鉴权。
const path = require("path");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "secure";
process.env.FILE_AUTH_COOKIE = "session_id";
delete process.env.FILE_AUTH_COOKIE_TOKENS;
delete process.env.FILE_AUTH_TOKEN;
process.env.RATE_LIMIT_ENABLED = "false";

const testDbStorage = path.join(__dirname, "tmp-test-auth-cookie-app.sqlite");
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

test("配置 cookieName 但无白名单：任意非空 Cookie → 401", async () => {
  const res = await request(app)
    .get("/api/file/status")
    .set("Cookie", "session_id=attacker-controlled");
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 401);
});

test("配置 cookieName 但无白名单：不带 Cookie → 401", async () => {
  const res = await request(app).get("/api/file/status");
  assert.equal(res.status, 401);
});
