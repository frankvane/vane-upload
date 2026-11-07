// 鉴权头解析：把组件 props 上的多种鉴权来源归一为一组请求头。
// 上传侧（ZustandFileUpload）使用。
//
// 设计要点：
// - 优先使用 `getAuthHeaders`（消费方完全自定义头，最灵活）。
// - 否则用 `getAuthToken` / `authToken` 拼成 `Authorization: <scheme> <token>`。
// - 同域 Cookie 场景下浏览器会自动携带（fetch 默认 same-origin、axios 默认
//   withCredentials:false），此处不强制塞 Cookie，避免重复。
export interface AuthHeadersConfig {
  /** 静态 Bearer Token（不推荐长期硬编码，适合演示） */
  authToken?: string;
  /** 动态取 Token（每次请求前调用，支持从异步存储/刷新逻辑取最新值） */
  getAuthToken?: () => string | undefined | Promise<string | undefined>;
  /** 完全自定义请求头（最高优先级，覆盖上面两者） */
  getAuthHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Token scheme，默认 Bearer */
  authScheme?: string;
  /** 是否以 credentials:'include' 发送请求（携带 Cookie）。
   *  默认 false：跨域走 Bearer 头鉴权，使用 same-origin，不触发 CORS 对
   *  Access-Control-Allow-Credentials:true 的强校验；
   *  仅当同域 Cookie 或跨域 Cookie 鉴权时才需设为 true（且服务端需返回
   *  Access-Control-Allow-Credentials:true）。 */
  withCredentials?: boolean;
}

/** 历史别名：上传侧 props 一直使用 UploadAuthConfig 命名，保留以兼容公共 API */
export type UploadAuthConfig = AuthHeadersConfig;

export async function resolveAuthHeaders(
  config: AuthHeadersConfig
): Promise<Record<string, string>> {
  if (config.getAuthHeaders) {
    const headers = await config.getAuthHeaders();
    return headers ?? {};
  }

  const scheme = config.authScheme || "Bearer";
  const token = config.getAuthToken
    ? await config.getAuthToken()
    : config.authToken;

  if (token) {
    return { Authorization: `${scheme} ${token}` };
  }

  return {};
}

/**
 * 归一化请求的 credentials 策略：
 * - 默认 `same-origin`：跨域 Bearer 头鉴权时不携带 Cookie，也不会触发 CORS
 *   preflight 对 Access-Control-Allow-Credentials:true 的强校验；
 * - 仅当显式开启 withCredentials（同域/跨域 Cookie 鉴权）时才 `include`，
 *   此时需服务端返回 Access-Control-Allow-Credentials:true。
 */
export const resolveRequestCredentials = (
  withCredentials?: boolean
): RequestCredentials => (withCredentials === true ? "include" : "same-origin");
