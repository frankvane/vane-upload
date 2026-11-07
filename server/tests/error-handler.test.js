// S6 回归：错误响应脱敏。
// - test/development 环境：回传原始 error.message（便于调试与既有测试）。
// - 其他环境（production）：仅返回通用文案，不得泄漏原始 message / 堆栈 / 路径。
// 注意：显式设置 NODE_ENV，避免与其他测试文件的全局 env 相互覆盖。
const test = require("node:test");
const assert = require("node:assert/strict");

const { errorHandler } = require("../src/app");

function makeRes() {
  return {
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
  };
}

test("test 环境：返回原始 error.message", () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const res = makeRes();
  errorHandler(new Error("boom-detail"), {}, res, () => {});
  process.env.NODE_ENV = prev;
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, 500);
  assert.equal(res.body.message, "boom-detail");
});

test("production 环境：仅返回通用文案，不泄漏原始 message", () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const res = makeRes();
  errorHandler(new Error("secret/path/or/sql/leak"), {}, res, () => {});
  process.env.NODE_ENV = prev;
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, 500);
  assert.equal(res.body.message, "internal server error");
  assert.notEqual(res.body.message, "secret/path/or/sql/leak");
});
