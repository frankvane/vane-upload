const test = require("node:test");
const assert = require("node:assert/strict");
const { rateLimitProxyReadiness } = require("../src/app");

// T-62：限流代理就绪自检（hops 启动自检 + 请求级分桶前提）。
// 纯函数注入参数，避免运行期 env 耦合，断言确定可重复。

test("T-62：限流开启但 TRUST_PROXY_HOPS=0 → 告警单桶退化", () => {
  const msg = rateLimitProxyReadiness({
    rateLimitEnabled: true,
    trustProxyHops: 0,
    isTest: false,
  });
  assert.ok(msg, "应返回告警文案");
  assert.match(msg, /单桶/);
  assert.match(msg, /TRUST_PROXY_HOPS/);
});

test("T-62：TRUST_PROXY_HOPS>=1 → 不告警", () => {
  assert.equal(
    rateLimitProxyReadiness({ rateLimitEnabled: true, trustProxyHops: 1, isTest: false }),
    null
  );
  assert.equal(
    rateLimitProxyReadiness({ rateLimitEnabled: true, trustProxyHops: 2, isTest: false }),
    null
  );
});

test("T-62：限流关闭 → 不告警", () => {
  assert.equal(
    rateLimitProxyReadiness({ rateLimitEnabled: false, trustProxyHops: 0, isTest: false }),
    null
  );
});

test("T-62：测试环境 → 不告警（避免淹没测试输出）", () => {
  assert.equal(
    rateLimitProxyReadiness({ rateLimitEnabled: true, trustProxyHops: 0, isTest: true }),
    null
  );
});
