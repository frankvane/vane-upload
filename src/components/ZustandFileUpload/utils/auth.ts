// 鉴权头解析已抽至 src/shared/authHeaders.ts（上传/下载两侧共用）。
// 此处保留 re-export，兼容既有 import 路径与公共 API（src/index.ts 导出）。
export {
  resolveAuthHeaders,
  resolveRequestCredentials,
  type AuthHeadersConfig,
  type UploadAuthConfig,
} from "../../../shared/authHeaders";
