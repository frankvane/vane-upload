import React from "react";
import { createRoot } from "react-dom/client";
import ZustandFileUpload from "./components/ZustandFileUpload";
import { API_BASE_URL, API_PATHS } from "./config/api";

/**
 * E2E 专用入口（仅供 Playwright 冒烟使用）。
 * 与 SimpleUploadDemo 同源，但显式关闭 autoCleanup，
 * 避免已完成文件在断言「已完成 / 秒传成功」状态前被自动清理，从而让状态断言稳定。
 */
const ALLOWED_FILE_TYPES: string[] = [];

const E2EApp: React.FC = () => (
  <ZustandFileUpload
    baseURL={API_BASE_URL}
    uploadApi={API_PATHS.file.upload}
    checkApi={API_PATHS.file.instant}
    chunkSize={1024 * 1024}
    fileConcurrency={2}
    chunkConcurrency={2}
    maxRetries={3}
    maxFileSize={2048 * 1024 * 1024}
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

createRoot(document.getElementById("root")!).render(<E2EApp />);
