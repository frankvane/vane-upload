/**
 * VU-55：全后端唯一的环境变量读取点。
 *
 * 设计约束（很重要）：
 * - 所有取值都是「函数」而不是模块加载期常量。既有测试会在运行时修改
 *   NODE_ENV / 配额上限，若在此处 Object.freeze 快照会让那些用例假绿或失效；
 *   同时 uploadController 的配额上限一直支持「运行时调整」，行为不能回退。
 * - 「集中」指的是读取入口集中、默认值集中、校验规则集中；
 *   `process.env` 只允许在本文件出现一次（get）。
 * - `validateStartupConfig()` 只在 bootstrap（非测试）调用，做部署期 fail-fast。
 */
const path = require("path");
const fs = require("fs");

const MB = 1024 * 1024;

const get = (key, fallback) => {
  const raw = process.env[key];
  return raw === undefined || raw === "" ? fallback : raw;
};

const getInt = (key, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const raw = get(key, String(fallback));
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
};

const getFloat = (key, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const raw = get(key, String(fallback));
  const parsed = Number.parseFloat(String(raw));
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
};

const getList = (key, fallback = [], { lowercase = true } = {}) => {
  const raw = get(key, "");
  if (!raw) return fallback;
  return String(raw)
    .split(",")
    .map((item) => (lowercase ? item.trim().toLowerCase() : item.trim()))
    .filter(Boolean);
};

const isDevOrTest = () => {
  const env = get("NODE_ENV", "development");
  return env === "test" || env === "development";
};

const config = {
  // 环境 / 服务
  nodeEnv: () => get("NODE_ENV", "development"),
  isTest: () => get("NODE_ENV", "development") === "test",
  isDevOrTest,
  port: () => getInt("PORT", 3000, { min: 1, max: 65535 }),
  shutdownTimeoutMs: () =>
    getInt("SHUTDOWN_TIMEOUT_MS", 15 * 1000, { min: 1000, max: 120000 }),
  trustProxyHops: () => getInt("TRUST_PROXY_HOPS", 0, { min: 0, max: 10 }),
  // VU-09：JSON 请求体上限。chunk_md5s 即使带满 10 万项也远小于 8MB，
  // 8MB 足够兼容旧客户端，同时把「20MB 匿名解析」的 DoS 面收窄 60%。
  jsonBodyLimitMb: () =>
    getFloat("JSON_BODY_LIMIT_MB", 8, { min: 0.01, max: 100 }),
  jsonBodyLimit: () => `${config.jsonBodyLimitMb()}mb`,

  // 鉴权
  authMode: () => String(get("AUTH_MODE", "secure")).toLowerCase(),
  // 凭据必须区分大小写，不能套用 MIME 名单的小写归一化。
  bearerTokens: () => getList("FILE_AUTH_TOKEN", [], { lowercase: false }),
  cookieName: () => get("FILE_AUTH_COOKIE", undefined),
  cookieTokens: () =>
    getList("FILE_AUTH_COOKIE_TOKENS", [], { lowercase: false }),
  demoUserId: () => get("DEMO_USER_ID", "test"),

  // CORS / 限流
  corsOrigin: () => String(get("CORS_ORIGIN", "")).trim(),
  rateLimitEnabled: () => get("RATE_LIMIT_ENABLED", "true") !== "false",
  // VU-55：RATE_LIMIT_MAX=0 过去被 `|| 300` 静默改回 300。
  // 现在 0 有明确语义 = 不挂载限流器；负数/非数字回退默认 300。
  rateLimitMax: () => getInt("RATE_LIMIT_MAX", 300, { min: 0, max: 1000000 }),

  // 容量 / 分片上限（字节）
  maxUploadSizeBytes: () => {
    const mb = getFloat("MAX_UPLOAD_SIZE_MB", 5120, { min: 0.001 });
    return mb * MB;
  },
  maxChunks: () => getInt("MAX_CHUNKS", 100000, { min: 1 }),
  maxTotalUploadSizeBytes: () => {
    const mb = getFloat("MAX_TOTAL_UPLOAD_SIZE_MB", 20480, { min: 0.001 });
    return mb * MB;
  },
  maxTotalChunks: () => getInt("MAX_TOTAL_CHUNKS", 200000, { min: 1 }),
  maxUserUploadSizeBytes: () => {
    const mb = getFloat("MAX_USER_UPLOAD_SIZE_MB", 10240, { min: 0.001 });
    return mb * MB;
  },
  maxUserChunks: () => getInt("MAX_USER_CHUNKS", 100000, { min: 1 }),
  chunkMaxSizeMb: () =>
    getFloat("CHUNK_MAX_SIZE_MB", 20, { min: 0.0001, max: 1024 }),

  // 目录 / 数据库（返回「覆盖值」；默认拼装仍由 paths.js / database.js 负责）
  serverDataDir: () => get("SERVER_DATA_DIR", ""),
  tmpUploadDir: () => get("SERVER_TMP_UPLOAD_DIR", ""),
  uploadsDir: () => get("SERVER_UPLOADS_DIR", ""),
  dbStorage: () => get("DB_STORAGE", ""),
  sqlLog: () => get("SQL_LOG", "") === "1",

  // janitor / 落库队列
  tmpTtlHours: () => getFloat("TMP_TTL_HOURS", 24, { min: 0.001 }),
  janitorIntervalHours: () =>
    getFloat("JANITOR_INTERVAL_HOURS", 6, { min: 0.001 }),
  chunkStateBatchSize: () => getInt("CHUNK_STATE_BATCH_SIZE", 40, { min: 1 }),
  chunkStateFlushIntervalMs: () =>
    getInt("CHUNK_STATE_FLUSH_INTERVAL_MS", 180, { min: 10 }),
  chunkStateMaxPending: () =>
    getInt("CHUNK_STATE_MAX_PENDING", 120, { min: 1 }),

  // VU-33：可选 MIME 白名单；未配置时走「危险类型黑名单」兜底。
  allowedMimeTypes: () => getList("ALLOWED_MIME_TYPES"),
  // VU-08：合并锁等待必须有超时与队列上限，否则一个卡住的合并会让
  // 后续同键请求无限挂起，并让等待者无界堆积。
  mergeWaitTimeoutMs: () =>
    getInt("MERGE_WAIT_TIMEOUT_MS", 30000, { min: 1000, max: 600000 }),
  mergeMaxWaiters: () =>
    getInt("MERGE_MAX_WAITERS", 64, { min: 1, max: 10000 }),

  // 日志
  logLevel: () => String(get("LOG_LEVEL", "info")).toLowerCase(),
};

/**
 * 启动期自检：生产部署缺凭据、目录不可写、配置非法时立刻退出，
 * 而不是等到第一个请求才暴露（fail-fast，只在 bootstrap 调用）。
 * @returns {{ok: boolean, errors: string[]}}
 */
const validateStartupConfig = ({ checkWritable = true } = {}) => {
  const errors = [];

  if (config.authMode() !== "demo") {
    const hasBearer = config.bearerTokens().length > 0;
    const hasCookie = Boolean(config.cookieName());
    if (!hasBearer && !hasCookie) {
      errors.push(
        "AUTH_MODE=secure 但 FILE_AUTH_TOKEN / FILE_AUTH_COOKIE 均未配置（所有 /api/file 请求会被拒绝）"
      );
    } else if (hasCookie && config.cookieTokens().length === 0) {
      errors.push(
        "已配置 FILE_AUTH_COOKIE 但缺少 FILE_AUTH_COOKIE_TOKENS（Cookie 分支将一律 401）"
      );
    }
  }
  if (config.corsOrigin() === "*") {
    errors.push("CORS_ORIGIN=* 不允许用于生产，请改为具体域名白名单");
  }
  if (config.maxUploadSizeBytes() > config.maxTotalUploadSizeBytes()) {
    errors.push("MAX_UPLOAD_SIZE_MB 不应大于 MAX_TOTAL_UPLOAD_SIZE_MB");
  }

  if (checkWritable) {
    const { DATA_DIR, TMP_UPLOAD_DIR, UPLOADS_DIR } = require("./paths");
    for (const dir of [DATA_DIR, TMP_UPLOAD_DIR, UPLOADS_DIR]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
      } catch (error) {
        errors.push(`目录不可写: ${dir} (${error.code || error.message})`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
};

module.exports = {
  config,
  validateStartupConfig,
  // 供其他 config 子模块复用的原语（避免它们各自再读 process.env）
  getEnv: get,
  getEnvInt: getInt,
  getEnvFloat: getFloat,
  getEnvPath: (key, fallback) => {
    const raw = get(key, "");
    return raw ? path.resolve(raw) : fallback;
  },
};
