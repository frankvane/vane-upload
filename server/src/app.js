const cors = require("cors");
const express = require("express");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const fileRoutes = require("./routes/fileRoutes");
const { createAuthMiddleware } = require("./middleware/auth");

const app = express();

// S5 指纹收敛：关闭 Express 默认 x-powered-by 响应头
app.disable("x-powered-by");

// S5 基础安全响应头（不引入额外依赖，避免新的供应链面）
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
});

// S4 CORS：默认不开启（不返回 Access-Control-Allow-Origin）。
// 必须显式设置 CORS_ORIGIN 为具体域名白名单（逗号分隔）才启用；
// 通配 * 视为不安全，仅作兼容告警且无法携带 Cookie 凭据。
const rawCorsOrigin = (process.env.CORS_ORIGIN || "").trim();
let corsOptions = null;
if (rawCorsOrigin && rawCorsOrigin !== "*") {
  const allowedOrigins = rawCorsOrigin
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  corsOptions = { origin: allowedOrigins, credentials: true };
} else if (rawCorsOrigin === "*") {
  console.warn(
    "[CORS] 检测到 CORS_ORIGIN=*（通配）。生产环境应改为具体域名白名单，且通配下无法携带 Cookie 凭据。"
  );
  corsOptions = { origin: true };
}
if (corsOptions) {
  app.use(cors(corsOptions));
}

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === "test" ? "tiny" : "dev"));

// 限流：默认 300 次/分钟/IP（RATE_LIMIT_MAX 可调，RATE_LIMIT_ENABLED=false 关闭）。
// 测试环境默认关闭，避免 supertest 批量请求被 429 拦截。
if (
  process.env.RATE_LIMIT_ENABLED !== "false" &&
  process.env.NODE_ENV !== "test"
) {
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number.parseInt(process.env.RATE_LIMIT_MAX || "", 10) || 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 429, message: "too many requests", data: {} },
  });
  app.use("/api/", limiter);
}

app.get("/api/health", (_req, res) => {
  res.json({
    code: 200,
    message: "ok",
    data: {
      now: new Date().toISOString(),
    },
  });
});

// S1 文件接口鉴权（参考实现，默认 secure / fail-closed）。
// AUTH_MODE 默认 `secure`：只要不是显式 `demo`，就挂载鉴权中间件，且永远以
// requireAuth:true 挂载——即使未配置任何凭据，所有 /api/file 请求也一律 401，
// 绝不出现"本应受保护却 silently 全开"。
// 仅 `AUTH_MODE=demo`（本地开发/测试）才关闭鉴权。生产必须配置 FILE_AUTH_TOKEN /
// FILE_AUTH_COOKIE，或替换为自家鉴权（portal_token 校验 + RBAC）。
const authMode = (process.env.AUTH_MODE || "secure").toLowerCase();
if (authMode !== "demo") {
  const bearerTokens = (process.env.FILE_AUTH_TOKEN || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const cookieName = process.env.FILE_AUTH_COOKIE || undefined;
  // P0-3：Cookie 分支必须有可校验的凭据（白名单或 verify），不能「有值即通过」。
  const cookieTokens = (process.env.FILE_AUTH_COOKIE_TOKENS || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const hasAnyConfig = bearerTokens.length > 0 || Boolean(cookieName);
  if (!hasAnyConfig) {
    // fail-closed：要求保护却未配置凭据 → 不允许 silent open，告警并一律拒绝。
    console.error(
      "[FATAL] AUTH_MODE=secure 但未配置 FILE_AUTH_TOKEN / FILE_AUTH_COOKIE，" +
        "所有 /api/file 请求将被拒绝（fail-closed）。本地调试可设 AUTH_MODE=demo；生产应配置凭据。"
    );
  } else if (cookieName && cookieTokens.length === 0) {
    console.error(
      "[FATAL] 已配置 FILE_AUTH_COOKIE 但未设置 FILE_AUTH_COOKIE_TOKENS，" +
        "Cookie 分支将一律返回 401（不再接受任意非空 Cookie）。" +
        "请配置白名单，或改用 FILE_AUTH_TOKEN / 自定义 verify。"
    );
  }
  app.use(
    "/api/file",
    createAuthMiddleware({
      bearerTokens,
      cookieTokens,
      cookieName,
      requireAuth: true,
    })
  );
} else {
  // P2-9：demo 模式没有凭据可派生身份，固定映射为历史默认用户 "test"，
  // 以兼容升级前写入的 file 行；生产环境永远走上面的凭据派生分支。
  app.use("/api/file", (req, _res, next) => {
    req.user = { id: process.env.DEMO_USER_ID || "test", source: "demo" };
    next();
  });
}

app.use("/api/file", fileRoutes);

// S6 错误脱敏：导出以便单测。
// 非 test/development 环境只返通用文案；真实堆栈/路径落服务端日志，不回传给客户端。
function errorHandler(error, _req, res, _next) {
  const isSafeEnv =
    process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development";
  if (!isSafeEnv) {
    console.error(
      "[server] unhandled error:",
      error && error.stack ? error.stack : error
    );
  }
  res.status(500).json({
    code: 500,
    message: isSafeEnv
      ? (error && error.message) || "internal server error"
      : "internal server error",
    data: {},
  });
}
app.use(errorHandler);

module.exports = app;
module.exports.errorHandler = errorHandler;
