/**
 * URL 安全校验（F3）：防止 Worker 把鉴权头（Bearer / Cookie）发往非白名单域名，
 * 缓解 SSRF / token 泄漏。
 *
 * 背景：下载 Worker 收到的分片 Range 请求 URL 由库按 baseURL 拼接，理论上同源；
 * 但若 baseURL 被错误/恶意配置（或未来支持外部 URL），Worker 会把 Authorization
 * 头原样发往任意域名。上传侧 URL 由 baseURL + 相对路径拼接，同理需校验。
 *
 * 设计：白名单以"宿主（host，含端口，小写）"为单位，http/https 同 host 视为一致。
 * 白名单为空时保持向后兼容（允许），交由调用方保证 baseURL 可信。
 */

export interface AllowedHostsOptions {
  baseURL?: string;
  extraHosts?: string[];
}

/** 把任意形式（完整 URL / 裸 host）归一化为小写 host；无法解析时返回原串小写。 */
function normalizeHost(input: string): string | null {
  const candidate = input.trim();
  if (!candidate) return null;
  try {
    // 已是完整 URL：直接取 host
    return new URL(candidate).host.toLowerCase();
  } catch {
    // 可能是裸 host（如 "api.example.com:8443"）：补协议再解析
    try {
      return new URL(`https://${candidate}`).host.toLowerCase();
    } catch {
      return candidate.toLowerCase();
    }
  }
}

/** 由 baseURL + 额外 host 列表推导允许宿主集合（去重、小写）。 */
export function getAllowedHosts(opts: AllowedHostsOptions): string[] {
  const hosts = new Set<string>();
  const base = normalizeHost(opts.baseURL ?? "");
  if (base) hosts.add(base);
  (opts.extraHosts ?? []).forEach((h) => {
    const normalized = normalizeHost(h);
    if (normalized) hosts.add(normalized);
  });
  return [...hosts];
}

/**
 * 校验目标 URL 是否允许携带鉴权头。
 * - allowedHosts 为空：保持向后兼容，允许（调用方需自行保证 baseURL 可信）。
 * - 否则：要求 URL 的 host 命中白名单（http/https 同 host 视为一致）。
 * - 解析失败 / 无 host（如非法地址，或 Worker 内无法解析的相对地址）：拒绝携带。
 */
export function isUrlAllowed(url: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return true;
  try {
    const parsed = new URL(url);
    if (!parsed.host) return false;
    return allowedHosts.includes(parsed.host.toLowerCase());
  } catch {
    return false;
  }
}
