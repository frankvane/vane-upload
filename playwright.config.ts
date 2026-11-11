import { defineConfig } from "@playwright/test";
import os from "node:os";
import { fileURLToPath } from "url";
import path from "path";
import {
  E2E_UPLOADS_DIR,
  E2E_DATA_DIR,
  E2E_TMP_UPLOAD_DIR,
} from "./e2e/e2e-paths";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * T-29：`PERF_PROD=1` 时前端改用 `vite preview` 起 `dist/demo`（生产构建），
 * 其余配置不变 —— dev 的模块拆分会把 Worker 启动开销放大数倍，
 * 只看 dev 数字会把「模块加载」误判成产品问题。
 */
const PERF_PROD = process.env.PERF_PROD === "1";
const WEB_BASE_URL = PERF_PROD
  ? "http://127.0.0.1:4173"
  : "http://127.0.0.1:5173";

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
  /**
   * 产物目录移出仓库：Playwright 每轮开头会递归清空 outputDir（trace/video 数量
   * 很容易超过平台批量删除守卫的 50 文件阈值，实测 241 个），导致整轮 e2e 直接
   * 起不来。指向系统临时目录后既不触发守卫，也不在仓库里留垃圾。
   */
  outputDir: process.env.PW_OUTPUT_DIR || path.join(os.tmpdir(), "vane-upload-pw"),
  // T-50：T-29 归因脚本（perf.*.spec.ts）默认不实际运行，但保留为「skipped」出现在 CI 汇总，
  // 而非被 testIgnore 静默剔除——这样评审能看清哪些用例被有意跳过（skip 清单可见）。
  // 是否真跑由其内部 test.skip(PERF_TRACE!=="1") 控制；PERF_TRACE=1 时两者都跑。
  // 首字节「预算」护栏（first-byte.budget.spec.ts）命名不含 perf.*，始终参与常规回归。
  // secure 模式 spec（secure.*.spec.ts）有独立配置 `playwright.secure.config.ts`（独立鉴权后端），
  // 不能跑在 demo 模式默认配置下（demo 后端不强制鉴权会让其断言失真），故在此排除。
  testIgnore: ["**/secure.*.spec.ts"],
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
      // 浏览器端强制不走任何系统/环境代理，直连本地 dev server（沙箱预设了 HTTP_PROXY）
      args: ["--no-proxy-server"],
    },
  },
  webServer: [
    {
      // T-43：改用 Playwright 的 `env` 字段注入环境变量，而非 Windows `set "X=Y" &&`
      // 语法——后者在 Linux CI runner 上 `bash` 把 `set "AUTH_MODE=demo"` 当成位置参数、
      // 不 export，后端以默认的 secure 模式启动，首条请求即 401，E2E 全绿实为假绿。
      // `env` 由 Playwright 跨平台设置，本地（Windows）与 CI（Linux）行为一致。
      command: "node server/src/index.js",
      env: {
        NODE_ENV: "development",
        PORT: "3000",
        AUTH_MODE: "demo",
        RATE_LIMIT_ENABLED: "false",
        SERVER_DATA_DIR: E2E_DATA_DIR,
        SERVER_TMP_UPLOAD_DIR: E2E_TMP_UPLOAD_DIR,
        SERVER_UPLOADS_DIR: E2E_UPLOADS_DIR,
      },
      cwd: __dirname,
      url: "http://127.0.0.1:3000/api/health",
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: PERF_PROD
        ? "npx vite preview --port 4173 --strictPort"
        : "npx vite --port 5173 --strictPort --host 127.0.0.1",
      cwd: __dirname,
      // Vite 的 SPA fallback 仅对 Accept: text/html 的请求返回 index.html，
      // Playwright 的就绪探针（Accept: */*）会被 404。改用经 Vite 代理到后端的
      // /api/health（JSON，任意 Accept 均返回 200）作为就绪判定。
      url: `${WEB_BASE_URL}/api/health`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
