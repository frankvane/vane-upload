import React from "react";
import { createRoot } from "react-dom/client";
import ZustandFileUpload from "./components/ZustandFileUpload";
import { API_BASE_URL, API_PATHS } from "./config/api";

/**
 * E2E 专用入口（小限制变体）：与 `e2e-main.tsx` 完全一致，仅把 `maxFileSize`
 * 降到 1MB，用于在「超大文件拦截」用例里用 2MB 文件触发 `文件大小超过限制`
 * 选择阶段拦截（避免为单测造一份 >2GB 的真实大文件）。拦截逻辑与正式 2048MB
 * 入口走的是同一段 `file.size > uploadConfig.maxFileSize` 判断，等价回归。
 */
const ALLOWED_FILE_TYPES: string[] = [];

export const E2ESmallLimitApp: React.FC = () => (
  <ZustandFileUpload
    baseURL={API_BASE_URL}
    uploadApi={API_PATHS.file.upload}
    checkApi={API_PATHS.file.instant}
    chunkSize={1024 * 1024}
    fileConcurrency={2}
    chunkConcurrency={2}
    maxRetries={3}
    maxFileSize={1 * 1024 * 1024}
    allowedFileTypes={ALLOWED_FILE_TYPES}
    maxFiles={10}
    autoUpload={true}
    autoCleanup={false}
    cleanupDelay={5}
    networkDisplayMode="tooltip"
    uiMode="simple"
    settingsSource="props"
  />
);

createRoot(document.getElementById("root")!).render(<E2ESmallLimitApp />);
