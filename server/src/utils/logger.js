/**
 * VU-38：统一分级日志 + 出站脱敏。
 *
 * 旧实现有三处泄漏/噪声：
 *  - `morgan("dev")` 记录含 query 的完整 URL（`/status?file_id=...&md5=...`）；
 *  - 生产 5xx 把完整 `error.stack`（含绝对路径、SQL 片段）打到控制台；
 *  - 各处直接 `console.log/warn/error`，无级别、无法统一采集。
 *
 * 轮转与 stdout 采集属于部署侧职责（不引入 winston/pino/logrotate 依赖），
 * 已在 server/README.md 写明基线。
 */
const { config } = require("../config");

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

let sink = null; // 测试可注入；null 时使用 console

const setLoggerSink = (fn) => {
  sink = typeof fn === "function" ? fn : null;
};

// 敏感 query 键值：连键名一起替换，日志里不出现 `file_id=` 这类可推导存储键的片段。
const QUERY_PATTERN =
  /([?&])(?:file_id|md5|chunk_md5|token|access_token|code|key|secret|auth|signature)=[^&\s"'<>]+/gi;
// 纯文本里的 KV 形式（错误堆栈、对象序列化后可能出现）
const KV_PATTERN =
  /\b(file_id|md5|authorization|cookie|set-cookie|token|api[_-]?key|secret)\s*[:=]\s*(?:Bearer\s+)?[^\s,;&}"']+/gi;
const BEARER_PATTERN = /\bBearer\s+\S+/gi;
// 绝对路径（Windows 盘符 + 常见 POSIX 根），避免把部署目录结构写进日志
const ABS_PATH_PATTERN =
  /(?:[A-Za-z]:[\\/][^\s"'(),;]+|\/(?:Users|home|root|var|srv|app|workspace|mnt|tmp)[^\s"'(),;]*)/g;

/** 导出以便单测与 morgan token 复用。 */
const redactLogText = (text) =>
  String(text)
    .replace(BEARER_PATTERN, "Bearer ***")
    .replace(QUERY_PATTERN, "$1[redacted]")
    .replace(KV_PATTERN, (match, key) => `${key}: ***`)
    .replace(ABS_PATH_PATTERN, "[path]");

const shouldLog = (level) =>
  LEVELS[level] >= (LEVELS[config.logLevel()] ?? LEVELS.info);

const serialize = (args) =>
  args
    .map((arg) => {
      if (arg instanceof Error) {
        return redactLogText(arg.stack || arg.message || String(arg));
      }
      if (typeof arg === "object" && arg !== null) {
        try {
          return redactLogText(JSON.stringify(arg));
        } catch {
          return "[unserializable]";
        }
      }
      return redactLogText(arg);
    })
    .join(" ");

const emit = (level, args) => {
  if (!shouldLog(level)) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${serialize(args)}`;
  if (sink) {
    sink(level, line);
    return;
  }
  const target = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  target(line);
};

const logger = {
  debug: (...args) => emit("debug", args),
  info: (...args) => emit("info", args),
  warn: (...args) => emit("warn", args),
  error: (...args) => emit("error", args),
};

/**
 * morgan 只记路径模板（pathname），绝不记 query 值。
 * 中间件挂在路由之前，拿不到 req.route.path，因此用 originalUrl 去掉 ? 之后的部分。
 */
const requestLogFormat = ":method :safe-path :status :response-time ms";

/** 只保留 pathname，导出以便单测直接验证「query 绝不进日志」。 */
const getSafePath = (req) => {
  const raw = String(req.originalUrl || req.url || "/");
  const queryAt = raw.indexOf("?");
  return queryAt >= 0 ? raw.slice(0, queryAt) : raw;
};

const registerSafePathToken = (morgan) => {
  morgan.token("safe-path", getSafePath);
};

const requestLogStream = {
  write: (line) => logger.info(String(line).trim()),
};

module.exports = {
  logger,
  redactLogText,
  setLoggerSink,
  requestLogFormat,
  registerSafePathToken,
  getSafePath,
  requestLogStream,
};
