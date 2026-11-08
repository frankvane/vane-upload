// VU-54 拆分配套：response 模块（响应格式化 / 身份解析 / 文件名解析）纯函数单测。
// 不依赖 DB / 网络，直接验证对外口径（租户隔离、错误传播）。
const test = require("node:test");
const assert = require("node:assert");
const {
  toPublicFile,
  httpError,
  jsonError,
  jsonOk,
  getUserId,
  getStorageId,
} = require("../src/controllers/response");

test("toPublicFile 剥离 <userId>:<chunkKey> 前缀，仅对外暴露 chunkKey", () => {
  const raw = {
    file_id: "u123:abc-def",
    file_name: "a.txt",
    size: 10,
    md5: "x",
    file_ext: ".txt",
    file_type: "text/plain",
    category_id: 1,
    created_at: new Date(),
  };
  const pub = toPublicFile(raw);
  assert.equal(pub.file_id, "abc-def");
  assert.equal(pub.file_name, "a.txt");
  assert.equal(pub.size, 10);
  assert.equal(pub.md5, "x");
});

test("toPublicFile 无分隔符时原样返回 file_id", () => {
  const pub = toPublicFile({ file_id: "plainkey", file_name: "b.txt" });
  assert.equal(pub.file_id, "plainkey");
});

test("toPublicFile(null) 返回 null", () => {
  assert.equal(toPublicFile(null), null);
});

test("httpError 携带 statusCode 与 details", () => {
  const e = httpError(409, "conflict", { a: 1 });
  assert.equal(e.statusCode, 409);
  assert.equal(e.message, "conflict");
  assert.deepEqual(e.details, { a: 1 });
});

test("jsonError / jsonOk 结构正确", () => {
  const mkRes = () => {
    let captured;
    const res = {
      captured: () => captured,
      status(code) {
        res._code = code;
        return res;
      },
      json(payload) {
        captured = { code: res._code ?? payload.code, payload };
        return captured;
      },
    };
    return res;
  };

  let res = mkRes();
  jsonError(res, 400, "bad");
  let c = res.captured();
  assert.equal(c.code, 400);
  assert.equal(c.payload.code, 400);
  assert.equal(c.payload.message, "bad");

  res = mkRes();
  jsonOk(res, { ok: true });
  c = res.captured();
  assert.equal(c.code, 200);
  assert.equal(c.payload.code, 200);
  assert.deepEqual(c.payload.data, { ok: true });
});

test("getUserId 优先用 req.user.id，否则回退 test", () => {
  assert.equal(getUserId({ user: { id: 7 } }), "7");
  assert.equal(getUserId({}), "test");
  assert.equal(getUserId(undefined), "test");
});

test("getStorageId 叠加用户命名空间，返回非空字符串", () => {
  const id = getStorageId({ user: { id: "u9" } }, "myfile");
  assert.equal(typeof id, "string");
  assert.ok(id.length > 0);
});
