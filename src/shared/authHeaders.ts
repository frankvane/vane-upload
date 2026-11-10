// 鉴权头解析：把组件 props 上的多种鉴权来源归一为一组请求头。
// 上传侧（ZustandFileUpload）使用。
//
// 设计要点：
// - 优先使用 `getAuthHeaders`（消费方完全自定义头，最灵活）。
// - 否则用 `getAuthToken` / `authToken` 拼成 `Authorization: <scheme> <token>`。
// - 同域 Cookie 场景下浏览器会自动携带（fetch 默认 same-origin、axios 默认
//   withCredentials:false），此处不强制塞 Cookie，避免重复。
import { IS_DEV } from "./isDev";
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

// 静态 token 会随宿主源码被打进前端 bundle，任何访问者都能读到；开发期提示一次，
// 生产环境请改用 getAuthToken 或同域 Cookie。文案同时是构建产物的检查标记
// （scripts/check-dev-only-code.mjs 会确认它没进 dist）。
const STATIC_TOKEN_WARNING =
  "[vane-upload][dev-only] 静态 authToken 可能会被打进前端 bundle：任何访问者都能读到该值。生产环境请改用 getAuthToken 动态取 token，或走同域 Cookie 鉴权。";

let staticTokenWarningShown = false;

/**
 * 开发期对静态 authToken 提示一次。判据是「写了静态值且没有动态取数」——
 * 即使 `getAuthHeaders` 覆盖了它，字面量仍留在 bundle 里，所以不看 getAuthHeaders。
 * 单次标记是模块级的：同一页面多个 <ZustandFileUpload> 实例、StrictMode 双渲染
 * 都只告警一次，避免刷屏。生产构建中 IS_DEV 为 false，整个函数体会被移除。
 */
export function warnIfStaticAuthToken(
  config: Pick<AuthHeadersConfig, "authToken" | "getAuthToken">
): void {
  if (!IS_DEV || staticTokenWarningShown) return;
  if (!config.authToken || config.getAuthToken) return;
  staticTokenWarningShown = true;
  console.warn(STATIC_TOKEN_WARNING);
}

export async function resolveAuthHeaders(
  config: AuthHeadersConfig
): Promise<Record<string, string>> {
  warnIfStaticAuthToken(config);

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
