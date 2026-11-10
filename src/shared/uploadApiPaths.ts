/**
 * 上传辅助接口（续传状态查询 / 删除时清理服务端分片）的路径解析。
 *
 * `statusApi` / `abortApi` 由宿主显式配置时优先；未配置时按命名约定从
 * `checkApi` / `uploadApi` 推导，推导不出来才回落到内置路径。
 * 主线程（useFileOperations）与上传 Worker 必须共用这套规则，避免两侧漂移。
 */

export const DEFAULT_STATUS_API = "/api/file/status";
export const DEFAULT_ABORT_API = "/api/file/abort";

/** 只有非空字符串才算「显式配置」；空串按未配置处理，避免拼出 baseURL 根路径。 */
const explicitOr = (explicit: string | undefined, derived: string): string =>
  typeof explicit === "string" && explicit.trim() !== "" ? explicit : derived;

/**
 * 续传状态接口。优先 `statusApi`；否则由 `checkApi` 按 `/instant → /status`
 * 推导，推导不出来才回落内置路径。
 */
export const resolveStatusApi = (
  checkApi: string,
  statusApi?: string
): string =>
  explicitOr(
    statusApi,
    /\/instant\/?$/.test(checkApi)
      ? checkApi.replace(/\/instant\/?$/, "/status")
      : DEFAULT_STATUS_API
  );

/**
 * 删除文件时清理服务端分片的接口。优先 `abortApi`；否则由 `uploadApi` 按
 * `/upload → /abort` 推导，推导不出来才回落内置路径。
 */
export const resolveAbortApi = (
  uploadApi: string,
  abortApi?: string
): string =>
  explicitOr(
    abortApi,
    /\/upload\/?$/.test(uploadApi)
      ? uploadApi.replace(/\/upload\/?$/, "/abort")
      : DEFAULT_ABORT_API
  );
