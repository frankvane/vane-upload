// 回归测试：app 级 fail-closed。
// AUTH_MODE=secure（默认）却未配置任何凭据 → 所有 /api/file 请求必须 401，
// 绝不允许 silent open（历史坑）。同时 /api/health 仍可用（服务器未崩溃）。
const path = require("path");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "secure"; // 默认即 secure；要求鉴权
// 故意不设置 FILE_AUTH_TOKEN / FILE_AUTH_COOKIE → 模拟“开了开关却忘配凭据”
const testDbStorage = path.join(__dirname, "tmp-test-auth-app.sqlite");
process.env.DB_STORAGE = testDbStorage;
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";
process.env.RATE_LIMIT_ENABLED = "false";

const app = require("../src/app");
const { syncModels, sequelize } = require("../src/models");

test.before(async () => {
  await syncModels({ force: true });
});

test.after(async () => {
  await sequelize.close();
  if (fs.existsSync(testDbStorage)) fs.unlinkSync(testDbStorage);
});

test("AUTH_MODE=secure 但未配凭据 → /api/file 一律 401", async () => {
  const res = await request(app).get("/api/file/status");
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 401);
});

test("未配凭据时即便带 Bearer 也 401（没有任何白名单可命中）", async () => {
  const res = await request(app)
    .get("/api/file/status")
    .set("Authorization", "Bearer anything");
  assert.equal(res.status, 401);
});

test("健康检查不受文件鉴权影响，服务器仍在线", async () => {
  const res = await request(app).get("/api/health");
  assert.equal(res.status, 200);
});
