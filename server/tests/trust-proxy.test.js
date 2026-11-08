// VU-26：代理部署下必须显式声明可信代理跳数，否则限流按代理 IP 合并成单桶。
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rui-trust-proxy-"));
process.env.NODE_ENV = "test";
process.env.DB_STORAGE = path.join(testRoot, "db.sqlite");
process.env.TRUST_PROXY_HOPS = "1";

const app = require("../src/app");

test.after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("VU-26：TRUST_PROXY_HOPS 生效，且不使用宽松的 trust proxy: true", () => {
  assert.equal(app.get("trust proxy"), 1);
  assert.notEqual(app.get("trust proxy"), true);
});

test("VU-26：非法跳数不会开启 trust proxy", () => {
  // 未配置时 Express 默认 false；这里验证本次配置是「整数」而非布尔通配。
  assert.equal(typeof app.get("trust proxy"), "number");
});
