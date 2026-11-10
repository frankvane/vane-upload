import React from "react";
import { createRoot } from "react-dom/client";
import ZustandFileUpload from "./components/ZustandFileUpload";
import { API_BASE_URL, API_PATHS } from "./config/api";

/**
 * E2E 专用入口（full UI）。
 *
 * 与 `e2e-main.tsx` 的差异仅在 `uiMode`：simple 模式不渲染 `BatchInfoDisplay`，
 * 因此「批次详情抽屉里的整批取消上传」这条链路（F-01/F-02）在 simple 页面上
 * 根本不可达。这里单独开一个 full 页面，专门回归批次级操作，
 * 避免改动既有 simple 页面而影响其他用例的布局与断言。
 */
const ALLOWED_FILE_TYPES: string[] = [];

export const E2EStandardApp: React.FC = () => (
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
    uiMode="full"
    settingsSource="props"
  />
);

createRoot(document.getElementById("root")!).render(<E2EStandardApp />);
