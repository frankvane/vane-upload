const test = require("node:test");
const assert = require("node:assert/strict");
const { createAuthMiddleware } = require("../src/middleware/auth");

// 用 res/next 桩模拟 express 中间件调用
function run(mw, { authorization, cookie, method, headers = {} } = {}) {
  const req = {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
  };
  const res = {
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
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };
  mw(req, res, next);
  return { res, nextCalled };
}

test("fail-closed 默认：无凭据一律 401（即便未配置任何校验）", () => {
  const mw = createAuthMiddleware(); // 默认 requireAuth:true，无任何 token/cookie/verify
  const { res, nextCalled } = run(mw, {});
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 401);
});

test("Bearer 命中白名单 → 放行", () => {
  const mw = createAuthMiddleware({ bearerTokens: ["secret"] });
  const { nextCalled, res } = run(mw, { authorization: "Bearer secret" });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test("Bearer 未命中白名单 → 401", () => {
  const mw = createAuthMiddleware({ bearerTokens: ["secret"] });
  const { nextCalled, res } = run(mw, { authorization: "Bearer wrong" });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("Cookie 命中白名单 → 放行", () => {
  const mw = createAuthMiddleware({
    cookieName: "sid",
    cookieTokens: ["abc123"],
  });
  const { nextCalled } = run(mw, { cookie: "sid=abc123" });
  assert.equal(nextCalled, true);
});

test("Cookie 值为任意非空但未命中白名单 → 401（P0-3）", () => {
  const mw = createAuthMiddleware({
    cookieName: "sid",
    cookieTokens: ["abc123"],
  });
  const { nextCalled, res } = run(mw, { cookie: "sid=whatever" });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("仅配置 cookieName、无 verify/白名单 → 401（不得存在即通过）", () => {
  const mw = createAuthMiddleware({ cookieName: "sid" });
  const { nextCalled, res } = run(mw, { cookie: "sid=abc123" });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("Cookie 未命中 → 401", () => {
  const mw = createAuthMiddleware({ cookieName: "sid", cookieTokens: ["abc123"] });
  const { nextCalled, res } = run(mw, { cookie: "other=x" });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("verify 回调放行 → 放行；拒绝则不放行（需回调自行 res 结束）", () => {
  // 契约：verify 要么调用 next() 放行，要么自行 res 结束拒绝；
  // 中间件不会在 verify 返回后补 401（与 README 一致）。
  const mw = createAuthMiddleware({
    verify: (token, _req, next) => {
      if (token === "good") return next();
      // 拒绝分支：真实场景应 res.status(401).json(...)，这里不调用 next 即视为拒绝
    },
  });
  const ok = run(mw, { authorization: "Bearer good" });
  assert.equal(ok.nextCalled, true);
  const bad = run(mw, { authorization: "Bearer bad" });
  assert.equal(bad.nextCalled, false);
});

test("显式 requireAuth:false 是唯一的放开口子（demo/测试）", () => {
  const mw = createAuthMiddleware({ requireAuth: false });
  const { nextCalled } = run(mw, {});
  assert.equal(nextCalled, true);
});

test("CSRF 纵深：Cookie 认证的非安全方法缺 X-Vane-Csrf 头 → 403", () => {
  const mw = createAuthMiddleware({
    cookieName: "sid",
    cookieTokens: ["abc123"],
    csrfProtection: true,
  });
  const { res, nextCalled } = run(mw, {
    cookie: "sid=abc123",
    method: "POST",
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 403);
});

test("CSRF 纵深：Cookie 认证的非安全方法带 X-Vane-Csrf 头 → 放行", () => {
  const mw = createAuthMiddleware({
    cookieName: "sid",
    cookieTokens: ["abc123"],
    csrfProtection: true,
  });
  const { nextCalled } = run(mw, {
    cookie: "sid=abc123",
    method: "POST",
    headers: { "x-vane-csrf": "1" },
  });
  assert.equal(nextCalled, true);
});

test("CSRF 纵深：Cookie 认证的安全方法（GET）无需 X-Vane-Csrf 头", () => {
  const mw = createAuthMiddleware({
    cookieName: "sid",
    cookieTokens: ["abc123"],
    csrfProtection: true,
  });
  const { nextCalled } = run(mw, { cookie: "sid=abc123" }); // method 缺省视为安全
  assert.equal(nextCalled, true);
});

test("CSRF 纵深：Bearer 认证不受 CSRF 约束（即便开启）", () => {
  const mw = createAuthMiddleware({ bearerTokens: ["secret"], csrfProtection: true });
  const { nextCalled } = run(mw, {
    authorization: "Bearer secret",
    method: "POST",
  });
  assert.equal(nextCalled, true);
});

test("CSRF 纵深：未开启时 Cookie 认证非安全方法无需 X-Vane-Csrf 头", () => {
  const mw = createAuthMiddleware({
    cookieName: "sid",
    cookieTokens: ["abc123"],
    csrfProtection: false,
  });
  const { nextCalled } = run(mw, { cookie: "sid=abc123", method: "POST" });
  assert.equal(nextCalled, true);
});
