// S4 回归：默认不开启 CORS。未设置 CORS_ORIGIN 时，任何 Origin 都不应拿到
// Access-Control-Allow-Origin 响应头（避免反射任意 Origin 造成跨域数据泄漏）。
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

process.env.NODE_ENV = "test";
// 不设置 CORS_ORIGIN → 默认不挂载 cors 中间件
const app = require("../src/app");

test("默认不开启 CORS：带 Origin 也不返回 Access-Control-Allow-Origin", async () => {
  const res = await request(app)
    .get("/api/health")
    .set("Origin", "https://evil.com");
  assert.equal(
    res.headers["access-control-allow-origin"],
    undefined,
    "默认不应反射任意 Origin"
  );
});
