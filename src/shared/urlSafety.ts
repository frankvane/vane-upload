/**
 * URL 安全校验（F3）：防止 Worker 把鉴权头（Bearer / Cookie）发往非白名单域名，
 * 缓解 SSRF / token 泄漏。
 *
 * 背景：下载 Worker 收到的分片 Range 请求 URL 由库按 baseURL 拼接，理论上同源；
 * 但若 baseURL 被错误/恶意配置（或未来支持外部 URL），Worker 会把 Authorization
 * 头原样发往任意域名。上传侧 URL 由 baseURL + 相对路径拼接，同理需校验。
 *
 * 设计：白名单以「宿主（host，含端口，小写）」为单位，http/https 同 host 视为一致。
 * 相对 baseURL（`/api`）与空 base 代表同源，不产生可白名单化的 host；此时白名单为
 * 空，`isUrlAllowed` 只允许同源 URL。绝对 baseURL 的 host 进白名单，供跨源上传
 * 场景放行。同源判定所需的 origin 由调用方**显式注入**，本模块不读 `self.location`，
 * 因此在 Worker、主线程与 Node 测试里的行为一致且可测。
 */

export interface AllowedHostsOptions {
  baseURL?: string;
  extraHosts?: string[];
}

const hasScheme = (value: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(value);

/** 把完整 URL / 裸 host 归一化为小写 host；同源相对形式返回 null。 */
function normalizeHost(input: string): string | null {
  const candidate = input.trim();
  if (!candidate) return null;

  // /api、./api、../api 是同源相对 base，没有可白名单化的 host。
  if (
    (candidate.startsWith("/") && !candidate.startsWith("//")) ||
    candidate.startsWith("./") ||
    candidate.startsWith("../")
  ) {
    return null;
  }

  // `//host/path` 是协议相对 URL，指向外域：取出 host 交给白名单判定。
  if (candidate.startsWith("//")) {
    try {
      return new URL(`https:${candidate}`).host.toLowerCase();
    } catch {
      return null;
    }
  }

  try {
    return new URL(candidate).host.toLowerCase();
  } catch {
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
 *
 * - 绝对 URL（含 scheme 或 `//host`）：host 命中白名单，或与 baseOrigin 同源才允许；
 *   白名单为空不再无条件放行，避免把 token 发往任意外域。
 * - 相对 URL：天然不会把 token 发往外域，但必须借调用方注入的 baseOrigin 解析成功；
 *   没有可信的同源参照时保守拒绝。
 */
export function isUrlAllowed(
  url: string,
  allowedHosts: string[],
  baseOrigin?: string
): boolean {
  const raw = String(url ?? "").trim();
  if (!raw) return false;

  let origin: URL | null = null;
  if (baseOrigin) {
    try {
      origin = new URL(baseOrigin);
    } catch {
      return false;
    }
  }

  const absoluteLike = hasScheme(raw) || raw.startsWith("//");
  let parsed: URL;
  try {
    parsed = new URL(raw, origin?.href);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!parsed.host) return false;

  if (!absoluteLike) {
    return origin !== null && parsed.origin === origin.origin;
  }
  if (origin && parsed.origin === origin.origin) return true;
  return allowedHosts.includes(parsed.host.toLowerCase());
}
