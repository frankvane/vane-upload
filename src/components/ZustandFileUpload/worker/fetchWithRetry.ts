/**
 * 带重试 / 超时 / 取消联动的 fetch（T-17：从 uploadWorker.ts 抽出）。
 *
 * 这里是**纯搬迁**：重试次数、5xx 退避、连接级错误立即失败、超时定时器收敛、
 * 鉴权头宿主白名单等语义一字未改，只把原先隐式依赖的 `debug` 与
 * `self.postMessage` 变成显式 deps —— 这样它可以脱离 Worker 全局环境，
 * 用 `vi.spyOn(globalThis, "fetch")` 直接单测。
 */
import { redactHeaders } from "../../../shared/redact";
import { isUrlAllowed } from "../../../shared/urlSafety";

export interface FetchRetryConfig {
  maxRetries?: number;
  timeout?: number;
  retryInterval?: number;
  authHeaders?: Record<string, string>;
  credentials?: RequestCredentials;
  /** F3：允许携带鉴权头的宿主白名单；URL host 不在白名单内时不附加 authHeaders */
  allowedHosts?: string[];
  /** 外部取消信号（任务级 AbortController）：abort 时中断在途 fetch 与重试 */
  signal?: AbortSignal;
}

export type RetryDebug = (
  message: string,
  data?: Record<string, unknown>,
  urgent?: boolean,
) => void;

export interface RetryExhaustedMessage {
  type: "retry";
  error: string;
  attemptNumber: number;
  retriesLeft: number;
  message: string;
}

export interface FetchRetryDeps {
  debug: RetryDebug;
  postMessage: (message: RetryExhaustedMessage) => void;
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  {
    maxRetries = 3,
    timeout = 30000,
    retryInterval = 1000,
    authHeaders,
    credentials,
    allowedHosts,
    signal,
  }: FetchRetryConfig = {},
  deps: FetchRetryDeps,
): Promise<Response> {
  const { debug, postMessage } = deps;
  // 默认 same-origin：跨域 Bearer 头鉴权时不携带 Cookie，也不会触发 preflight
  // 对 Access-Control-Allow-Credentials:true 的强校验；仅当显式传入 'include' 时才携带 Cookie。
  const requestCredentials: RequestCredentials = credentials ?? "same-origin";
  debug(`开始请求: ${url}`, { method: options.method, maxRetries });

  // 合并鉴权头（authHeaders 优先级低于调用方显式 headers，避免覆盖 Content-Type 等）
  // F3：仅当目标 URL 的 host 命中白名单时才附加 authHeaders；非白名单域名
  // （如错误的 baseURL / 外部 URL）一律不携带 Bearer，避免 token 泄漏到任意站点。
  const sendAuth = isUrlAllowed(url, allowedHosts ?? []);
  const mergedHeaders: Record<string, string> = {
    ...(sendAuth ? (authHeaders ?? {}) : {}),
    ...(options.headers as Record<string, string> | undefined),
  };

  return new Promise<Response>((resolve, reject) => {
    // 自定义重试逻辑，不使用async库
    let attempts = 0;

    const makeRequest = async () => {
      // 取消后不再发起（或重试）任何请求
      if (signal?.aborted) {
        const error = new Error("上传已取消");
        error.name = "AbortError";
        reject(error);
        return;
      }

      // 如果超过最大重试次数，则拒绝
      if (attempts >= maxRetries) {
        const error = new Error(`已达到最大重试次数: ${maxRetries}`);
        debug(
          `请求最终失败: ${url}`,
          { error: error.message, maxRetries },
          true,
        );
        postMessage({
          type: "retry",
          error: error.message,
          attemptNumber: maxRetries,
          retriesLeft: 0,
          message: `已达到最大重试次数(${maxRetries}次)，上传失败`,
        });
        reject(error);
        return;
      }

      attempts++;
      const currentAttempt = attempts;

      // 超时定时器句柄提升到 try 外：确保 5xx 重试 / 网络异常分支
      // 也能在 finally 中收敛，避免定时器残留
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        // 创建 AbortController 用于超时控制
        const controller = new AbortController();
        // 外部取消信号联动：CANCEL 到达时一并中断在途 fetch
        if (signal) {
          if (signal.aborted) {
            controller.abort();
          } else {
            signal.addEventListener("abort", () => controller.abort(), {
              once: true,
            });
          }
        }
        timeoutId = setTimeout(() => {
          debug(`请求超时: ${url}`, { timeout, attempt: currentAttempt }, true);
          controller.abort();
        }, timeout);

        debug(`执行请求: ${url} (尝试 ${currentAttempt}/${maxRetries})`, {
          method: options.method,
          headers: redactHeaders(mergedHeaders),
          bodyType: options.body ? typeof options.body : undefined,
        });

        const response = await fetch(url, {
          ...options,
          headers: mergedHeaders,
          // credentials 策略：默认 same-origin（跨域不送 Cookie，Authorization 头照常发送）；
          // 仅当 uploadConfig.withCredentials 为 true（同域/跨域 Cookie 鉴权）时才 'include'，
          // 此时需服务端返回 Access-Control-Allow-Credentials:true。
          credentials: requestCredentials,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        debug(`请求完成: ${url} (尝试 ${currentAttempt}/${maxRetries})`, {
          status: response.status,
          statusText: response.statusText,
        });

        if (!response.ok) {
          let errorText = "";
          let apiMessage: string | undefined;
          try {
            errorText = await response.text();
            if (errorText) {
              try {
                const parsed = JSON.parse(errorText) as { message?: unknown };
                if (typeof parsed.message === "string" && parsed.message) {
                  apiMessage = parsed.message;
                }
              } catch {
                // 非 JSON 错误响应时保留原始文本到日志即可
              }
            }
          } catch {
            debug("无法读取错误响应内容");
          }

          const error = new Error(
            apiMessage
              ? `HTTP 错误 ${response.status}: ${apiMessage}`
              : `HTTP 错误 ${response.status}: ${response.statusText}`,
          );
          debug(
            `请求失败: ${url} (尝试 ${currentAttempt}/${maxRetries})`,
            {
              status: response.status,
              statusText: response.statusText,
              errorText: errorText.substring(0, 200),
              apiMessage,
            },
            true,
          );

          // 判断是否需要重试
          const isServerError = response.status >= 500;
          if (isServerError && attempts < maxRetries) {
            const nextRetryDelay = retryInterval * currentAttempt;
            debug(`将在 ${nextRetryDelay}ms 后重试请求`, undefined, true);
            setTimeout(makeRequest, nextRetryDelay);
            return;
          }

          reject(error);
          return;
        }

        // 请求成功
        debug(`请求成功: ${url} (尝试 ${currentAttempt}/${maxRetries})`);
        resolve(response);
      } catch (error) {
        const wrappedError =
          error instanceof Error ? error : new Error(String(error));
        debug(
          `请求异常: ${url} (尝试 ${currentAttempt}/${maxRetries})`,
          { error: wrappedError.message },
          true,
        );

        // E2E-04：网络错误 / 超时即判失败，不再按 maxRetries 反复等待。
        // 后端不可用时每次尝试都必然失败，继续重试只会让 UI 长时间停在
        // 「上传中 0%」；5xx 的重试仍保留在上面的响应分支。
        const isNetworkError =
          wrappedError.name === "TypeError" ||
          wrappedError.message.includes("network");
        const isTimeoutError =
          wrappedError.name === "AbortError" ||
          wrappedError.message.includes("timeout");
        debug(
          `请求异常直接失败${
            isNetworkError || isTimeoutError ? "（连接级错误，不再重试）" : ""
          }`,
          { error: wrappedError.message },
          true,
        );

        reject(wrappedError);
      } finally {
        // 收敛定时器：无论成功、5xx 重试还是网络异常，都不残留未清理的 timeout
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
    };

    // 开始第一次请求
    makeRequest();
  });
}

/** 绑定 Worker 侧的日志 / 消息出口，返回一个与旧签名一致的函数。 */
export const bindFetchWithRetry = (deps: FetchRetryDeps) =>
  (
    url: string,
    options: RequestInit,
    config: FetchRetryConfig = {},
  ): Promise<Response> => fetchWithRetry(url, options, config, deps);
