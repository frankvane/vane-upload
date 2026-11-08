import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "url";
import path from "path";
import {
  E2E_UPLOADS_DIR,
  E2E_DATA_DIR,
  E2E_TMP_UPLOAD_DIR,
} from "./e2e/e2e-paths";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 沙箱环境预设了 HTTP_PROXY，且当前 Node 版本会自动将其应用于 localhost 请求，
// 导致 Playwright 的 webServer 就绪探针（以及浏览器）把 127.0.0.1 也走代理 → 502。
// 这里显式声明 localhost/127.0.0.1 不走代理，确保探针与浏览器直连本地服务。
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

/**
 * VU-63 浏览器级 E2E。
 *
 * 启动两个 webServer：
 *  1) 后端 Express（端口 3000，AUTH_MODE=demo 关闭鉴权以匹配无凭据的前端 demo，
 *     并将数据/分片/产物目录重定向到固定临时目录，避免污染仓库与单测数据）。
 *  2) 前端 Vite dev（端口 5173，内置 /api 代理到 localhost:3000）。
 *
 * E2E 用例从固定目录 E2E_UPLOADS_DIR 读取后端合并产物，按 md5 校验「产物一致」。
 * 该目录路径固定（见 e2e/e2e-paths.ts），配置、globalSetup、用例三侧独立计算均一致。
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
    trace: "retain-on-failure",
    launchOptions: {
      // 浏览器端强制不走任何系统/环境代理，直连本地 dev server（沙箱预设了 HTTP_PROXY）
      args: ["--no-proxy-server"],
    },
  },
  webServer: [
    {
      command: `set "NODE_ENV=development" && set "PORT=3000" && set "AUTH_MODE=demo" && set "RATE_LIMIT_ENABLED=false" && set "SERVER_DATA_DIR=${E2E_DATA_DIR}" && set "SERVER_TMP_UPLOAD_DIR=${E2E_TMP_UPLOAD_DIR}" && set "SERVER_UPLOADS_DIR=${E2E_UPLOADS_DIR}" && node server/src/index.js`,
      cwd: __dirname,
      url: "http://127.0.0.1:3000/api/health",
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: "npx vite --port 5173 --strictPort --host 127.0.0.1",
      cwd: __dirname,
      // Vite 的 SPA fallback 仅对 Accept: text/html 的请求返回 index.html，
      // Playwright 的就绪探针（Accept: */*）会被 404。改用经 Vite 代理到后端的
      // /api/health（JSON，任意 Accept 均返回 200）作为就绪判定。
      url: "http://127.0.0.1:5173/api/health",
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
