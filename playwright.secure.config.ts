import { defineConfig } from "@playwright/test";
import os from "node:os";
import { fileURLToPath } from "url";
import path from "path";
import {
  E2E_UPLOADS_DIR,
  E2E_DATA_DIR,
  E2E_TMP_UPLOAD_DIR,
} from "./e2e/e2e-paths";

/**
 * T-49：secure 模式 E2E 专用配置（与默认 `playwright.config.ts` 的 demo 模式并列）。
 *
 * 默认配置把后端锁在 `AUTH_MODE=demo`（鉴权关闭）以匹配无凭据的前端 demo，导致现有
 * 12 条 E2E 根本不碰鉴权头——改坏 `resolveAuthHeaders` 也不会红。本配置起一个
 * `AUTH_MODE=secure` + `FILE_AUTH_TOKEN` 的后端（独立端口，避免与 demo 后端 :3000 冲突），
 * 并由 `e2e-secure.html` 注入同源令牌，专门回归「带鉴权的上传链路」：
 *  - `secure.smoke.spec.ts` 的 secure 冒烟依赖 `Authorization: Bearer` 头，改坏
 *    `resolveAuthHeaders` 拼接 → 该用例必红（T-49 变异自查锚点）。
 *  - token 过期/轮换：前端在运行时把令牌改成错误值触发 401，再改回正确值重试成功。
 *
 * 与默认配置复用同一套 `.e2e-tmp` 固定目录（globalSetup 每轮清空），故本配置应作为
 * 独立 CI job / 单独 `npx playwright test` 运行，勿与默认配置并发执行。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SECURE_TOKEN = "e2e-secure-token";
const BACKEND_PORT = 3001;
const FRONTEND_PORT = 5174;
const WEB_BASE_URL = `http://127.0.0.1:${FRONTEND_PORT}`;

// 沙箱预设了 HTTP_PROXY，且 Node 会把 127.0.0.1 也走代理 → 探针/浏览器 502/连接拒绝。
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

export default defineConfig({
  testDir: "./e2e",
  // 只跑 secure 专用 spec，避免与 demo 模式 spec 混跑（两者后端鉴权状态不同）。
  testMatch: /secure\.smoke\.spec\.ts$/,
  outputDir:
    process.env.PW_OUTPUT_DIR || path.join(os.tmpdir(), "vane-upload-pw-secure"),
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: WEB_BASE_URL,
    headless: true,
    trace: "retain-on-failure",
    launchOptions: {
      args: ["--no-proxy-server"],
    },
  },
  webServer: [
    {
      // secure 后端：显式开启鉴权并配置白名单令牌（与前端注入的令牌一致）。
      command: "node server/src/index.js",
      env: {
        NODE_ENV: "development",
        PORT: String(BACKEND_PORT),
        AUTH_MODE: "secure",
        FILE_AUTH_TOKEN: SECURE_TOKEN,
        SERVER_DATA_DIR: E2E_DATA_DIR,
        SERVER_TMP_UPLOAD_DIR: E2E_TMP_UPLOAD_DIR,
        SERVER_UPLOADS_DIR: E2E_UPLOADS_DIR,
      },
      cwd: __dirname,
      url: `http://127.0.0.1:${BACKEND_PORT}/api/health`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      // secure 前端：独立端口，并把 /api 代理到上面的 secure 后端（端口 3001）。
      command: `npx vite --port ${FRONTEND_PORT} --strictPort --host 127.0.0.1`,
      env: {
        VITE_DEV_API_PROXY_TARGET: `http://localhost:${BACKEND_PORT}`,
      },
      cwd: __dirname,
      url: `${WEB_BASE_URL}/api/health`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
