const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

// 需要在 require app 前设置：非 test 环境 + 显式开启限流 + CORS 白名单
process.env.NODE_ENV = "production";
process.env.RATE_LIMIT_ENABLED = "true";
process.env.RATE_LIMIT_MAX = "3";
process.env.CORS_ORIGIN = "https://allowed.com";
const testDbStorage = path.join(__dirname, "tmp-test-security.sqlite");
process.env.DB_STORAGE = testDbStorage;
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";

const app = require("../src/app");
const { syncModels, sequelize } = require("../src/models");

const ALLOWED_ORIGIN = "https://allowed.com";
const EVIL_ORIGIN = "https://evil.com";

test.before(async () => {
  await syncModels({ force: true });
});

test.after(async () => {
  await sequelize.close();
  if (fs.existsSync(testDbStorage)) fs.unlinkSync(testDbStorage);
});

test("CORS 白名单：允许的 origin 返回 Access-Control-Allow-Origin", async () => {
  const res = await request(app)
    .options("/api/file/instant")
    .set("Origin", ALLOWED_ORIGIN)
    .set("Access-Control-Request-Method", "POST");

  assert.equal(res.headers["access-control-allow-origin"], ALLOWED_ORIGIN);
  assert.equal(res.headers["access-control-allow-credentials"], "true");
});

test("CORS 白名单：不在名单的 origin 拿不到允许头", async () => {
  const res = await request(app)
    .options("/api/file/instant")
    .set("Origin", EVIL_ORIGIN)
    .set("Access-Control-Request-Method", "POST");

  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("限流：超过 RATE_LIMIT_MAX 后返回 429（preflight 不受限流影响）", async () => {
  // cors 中间件在 limiter 之前，OPTIONS preflight 不消耗配额；
  // 上面的 CORS 用例已用掉部分配额，这里连续打满阈值验证 429。
  const statuses = [];
  for (let i = 0; i < 8; i += 1) {
    const res = await request(app).get("/api/health");
    statuses.push(res.status);
  }

  assert.ok(
    statuses.includes(429),
    `expected 429 in ${JSON.stringify(statuses)}`
  );
  const first429 = statuses.indexOf(429);
  assert.ok(
    statuses.slice(first429).every((s) => s === 429),
    "达到阈值后应持续 429"
  );
  assert.equal(
    statuses.filter((s) => s === 200).length + statuses.filter((s) => s === 429).length,
    statuses.length
  );
});
