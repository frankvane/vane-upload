/**
 * 上传失败分类（T-17：从 uploadWorker.ts 抽出，纯函数搬迁）。
 * 决定「取消 / 连接级失败 / 后端整体不可用」三种语义，供收尾分支选择上报文案。
 */

/** VU-07：区分「用户主动取消」与「真实失败」，避免 AbortError 被渲染成失败状态。 */
export const isCancellation = (
  error: unknown,
  signal?: AbortSignal,
): boolean =>
  Boolean(signal?.aborted) ||
  (error instanceof Error &&
    (error.name === "AbortError" || error.message === "上传已取消"));

/**
 * E2E-04：连接级失败（网络断开 / 请求超时 / 后端不可达）。
 * 这类错误继续跑完整条上传链路没有意义，应尽快上报明确错误让用户重试。
 */
export const isConnectionFailure = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "TypeError" ||
    error.name === "AbortError" ||
    error.message.includes("network") ||
    error.message.includes("timeout") ||
    error.message.includes("Failed to fetch")
  );
};

/**
 * E2E-04：后端整体不可用（连接级失败或 5xx）。
 * 仅用于「预检 + 状态查询」两次探测都失败时的快速失败判定；
 * 单个分片的 5xx 仍按原有重试 + 继续策略处理，避免一处抖动中断整个文件。
 */
export const isBackendUnavailable = (error: unknown): boolean =>
  isConnectionFailure(error) ||
  (error instanceof Error && /^HTTP 错误 5\d\d/.test(error.message));
