// 公共入口：仅导出上传链路。
import "./ui/ui.css";

export { default } from "./components/ZustandFileUpload";
export { default as FileUpload, default as ZustandFileUpload } from "./components/ZustandFileUpload";

export {
  UploadStatus,
  statusMap,
  type UploadFile,
  type UploadUIMode,
  type UploadSettingsSource,
  type ZustandFileUploadProps,
  type UploadColumnKey,
  type UploadConfig,
  type UploadAuthConfig,
  type BatchInfo,
  type ProcessProgress,
  type AlignItem,
} from "./components/ZustandFileUpload/types/upload";

export { resolveAuthHeaders } from "./components/ZustandFileUpload/utils/auth";

// 调试日志开关：库默认静默，消费方排查时调用 configureDebug({ silent: false }) 打开。
export {
  configureDebug,
  getDebugLog,
  clearDebugLog,
} from "./shared/debugLogger";

// UI 套件类型：消费方实现 setMessageApi 注入时需要 MessageInstance 签名
export type { MessageInstance } from "./ui";

// 顶层错误边界，避免旧 chunk 404 导致整页白屏
export { ErrorBoundary } from "./ui";
export type { ErrorBoundaryProps } from "./ui";
