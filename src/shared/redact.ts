/**
 * VU-05：日志与调试输出中的凭据脱敏。
 * 纯函数、无 DOM / Worker 依赖，主线程、Worker、服务端均可安全复用。
 */

const SENSITIVE_KEYS =
  "authorization|cookie|set-cookie|proxy-authorization|x-[a-z0-9-]*(?:token|key|secret|auth)";

const SENSITIVE_HEADER_PATTERN = new RegExp(`^(${SENSITIVE_KEYS})$`, "i");
const JSON_KV_PATTERN = new RegExp(
  `"(${SENSITIVE_KEYS})"\\s*:\\s*"[^"]*"`,
  "gi",
);
// 值可能是 "Bearer <token>"（含空格）：必须把 token 一并吃掉，
// 否则先替换掉 "Bearer" 后，后面的裸 token 会逃过 BEARER_PATTERN 而泄漏。
const PLAIN_KV_PATTERN = new RegExp(
  `\\b(${SENSITIVE_KEYS})\\s*[:=]\\s*(?:Bearer\\s+)?[^\\s,}&;]+`,
  "gi",
);
const BEARER_PATTERN = /\bBearer\s+\S+/gi;

/** 请求头对象：敏感键的值替换为 ***，其余原样保留。 */
export const redactHeaders = (
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  if (!headers) return undefined;
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    safe[key] = SENSITIVE_HEADER_PATTERN.test(key) ? "***" : value;
  }
  return safe;
};

/** 任意日志文本：覆盖 JSON 键值、纯文本键值与裸 Bearer token。 */
export const scrubLogText = (text: string): string =>
  text
    .replace(JSON_KV_PATTERN, '"$1":"***"')
    .replace(PLAIN_KV_PATTERN, "$1: ***")
    .replace(BEARER_PATTERN, "Bearer ***");
