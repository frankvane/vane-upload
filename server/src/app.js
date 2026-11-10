const cors = require("cors");
const express = require("express");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const fileRoutes = require("./routes/fileRoutes");
const { createAuthMiddleware } = require("./middleware/auth");
const { getQueueHealth } = require("./services/chunkStateQueue");
const { config } = require("./config");
const {
  logger,
  requestLogFormat,
  registerSafePathToken,
  requestLogStream,
} = require("./utils/logger");

const app = express();

// VU-26：Express 默认 trust proxy=false，反代后 req.ip 恒为代理地址，
// 限流会退化成「全站共用一个桶」。按实际跳数显式声明可信代理层数；
// 绝不设 `trust proxy: true`（那会让伪造 X-Forwarded-For 绕过限流）。
const trustProxyHops = config.trustProxyHops();
if (trustProxyHops > 0) {
  app.set("trust proxy", trustProxyHops);
}

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
const rawCorsOrigin = config.corsOrigin();
let corsOptions = null;
if (rawCorsOrigin && rawCorsOrigin !== "*") {
  const allowedOrigins = rawCorsOrigin
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  corsOptions = { origin: allowedOrigins, credentials: true };
} else if (rawCorsOrigin === "*") {
  logger.warn(
    "[CORS] 检测到 CORS_ORIGIN=*（通配）。生产环境应改为具体域名白名单，且通配下无法携带 Cookie 凭据。"
  );
  corsOptions = { origin: true };
}
if (corsOptions) {
  app.use(cors(corsOptions));
}

// VU-38：请求日志只记 pathname，绝不记录 query 值
// （`/status?file_id=...&md5=...` 会把存储键与哈希写进日志）。
registerSafePathToken(morgan);
// 测试环境不刷请求日志（几十条/文件会淹没 TAP 输出）；分级本身由 LOG_LEVEL 控制。
if (!config.isTest()) {
  app.use(morgan(requestLogFormat, { stream: requestLogStream }));
}

// 限流：默认 300 次/分钟/IP（RATE_LIMIT_MAX 可调，RATE_LIMIT_ENABLED=false 关闭）。
// VU-55：RATE_LIMIT_MAX=0 现在有明确语义「不挂载限流器」，不再被 `|| 300` 悄悄改回。
// 测试环境默认关闭，避免 supertest 批量请求被 429 拦截。
if (config.rateLimitEnabled() && !config.isTest()) {
  const limit = config.rateLimitMax();
  if (limit > 0) {
    const limiter = rateLimit({
      windowMs: 60 * 1000,
      limit,
      standardHeaders: true,
      legacyHeaders: false,
      // 不写自定义 keyGenerator：express-rate-limit 的默认 keyGenerator 已按 request.ip
      // 分桶，并套用 IPv6 子网归一化（ipv6Subnet 默认 /56 + ipKeyGenerator），
      // 既满足「代理下各自计数」（配合上面的 trust proxy 跳数），又对 IPv6 正确。
      // 自定义 keyGenerator 若直接引用 req.ip 而不用 ipKeyGenerator，会触发
      // ERR_ERL_KEY_GEN_IPV6 校验错误（启动期被当成 ERROR 打印，易误判为崩溃）。
      message: { code: 429, message: "too many requests", data: {} },
    });
    app.use("/api/", limiter);
  }
}

app.get("/api/health", (_req, res) => {
  // VU-36：落库队列持续失败时健康检查必须报 degraded，而不是恒 200 假绿。
  const chunkQueue = getQueueHealth();
  res.json({
    code: 200,
    message: chunkQueue.degraded ? "degraded" : "ok",
    data: {
      now: new Date().toISOString(),
      chunkQueue,
    },
  });
});

// S1 文件接口鉴权（参考实现，默认 secure / fail-closed）。
// AUTH_MODE 默认 `secure`：只要不是显式 `demo`，就挂载鉴权中间件，且永远以
// requireAuth:true 挂载——即使未配置任何凭据，所有 /api/file 请求也一律 401，
// 绝不出现"本应受保护却 silently 全开"。
// 仅 `AUTH_MODE=demo`（本地开发/测试）才关闭鉴权。生产必须配置 FILE_AUTH_TOKEN /
// FILE_AUTH_COOKIE，或替换为自家鉴权（portal_token 校验 + RBAC）。
const authMode = config.authMode();
if (authMode !== "demo") {
  const bearerTokens = config.bearerTokens();
  const cookieName = config.cookieName();
  // P0-3：Cookie 分支必须有可校验的凭据（白名单或 verify），不能「有值即通过」。
  const cookieTokens = config.cookieTokens();
  const hasAnyConfig = bearerTokens.length > 0 || Boolean(cookieName);
  if (!hasAnyConfig) {
    // fail-closed：要求保护却未配置凭据 → 不允许 silent open，告警并一律拒绝。
    logger.error(
      "[FATAL] AUTH_MODE=secure 但未配置 FILE_AUTH_TOKEN / FILE_AUTH_COOKIE，" +
        "所有 /api/file 请求将被拒绝（fail-closed）。本地调试可设 AUTH_MODE=demo；生产应配置凭据。"
    );
  } else if (cookieName && cookieTokens.length === 0) {
    logger.error(
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
    req.user = { id: config.demoUserId(), source: "demo" };
    next();
  });
}

// VU-09：body parser 必须挂在鉴权之后、且只作用于 /api/file。
// 旧实现全局 `express.json({limit:"20mb"})` 在鉴权前解析：任何匿名请求都能
// 让服务端先解析 20MB JSON 再返回 401，是纯粹的 CPU/内存 DoS 面。
// 现在未鉴权请求直接 401（零解析），上限收紧到 8MB（可配 JSON_BODY_LIMIT_MB）。
app.use(
  "/api/file",
  express.json({ limit: config.jsonBodyLimit() }),
  express.urlencoded({ extended: true, limit: config.jsonBodyLimit() })
);

app.use("/api/file", fileRoutes);

// S6 错误脱敏：导出以便单测。
// 非 test/development 环境只返通用文案；真实堆栈/路径落服务端日志，不回传给客户端。
function errorHandler(error, _req, res, _next) {
  const isSafeEnv = config.isDevOrTest();

  // VU-10 / VU-32：multer 与 body-parser 的确定性客户端错误不该变成 500，
  // 否则客户端 fetchWithRetry 会对必然失败的请求反复重试。
  let statusCode = 500;
  let message = (error && error.message) || "服务器内部错误，请稍后重试";
  const details = {};

  if (error && error.name === "MulterError") {
    statusCode = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    message =
      error.code === "LIMIT_FILE_SIZE"
        ? "分片大小超过允许的最大值"
        : `multipart 请求格式非法：${error.code}`;
    details.code = error.code;
    details.maxMb = config.chunkMaxSizeMb();
  } else if (error && (error.type === "entity.too.large" || error.status === 413)) {
    statusCode = 413;
    message = "请求体超过允许的大小";
  } else if (Number.isInteger(error && error.statusCode)) {
    statusCode = error.statusCode;
  }

  if (statusCode >= 500 && !isSafeEnv) {
    // VU-38：完整 stack 含绝对路径 / SQL 片段，logger 会统一脱敏后再落服务端日志。
    logger.error("[server] unhandled error:", error);
    message = "服务器内部错误，请稍后重试";
  } else if (statusCode >= 500 && isSafeEnv) {
    // test/development 保留原始 message 便于定位；已有单测依赖该行为。
    message = (error && error.message) || "服务器内部错误，请稍后重试";
  }

  res.status(statusCode).json({ code: statusCode, message, data: details });
}
app.use(errorHandler);

module.exports = app;
module.exports.errorHandler = errorHandler;
