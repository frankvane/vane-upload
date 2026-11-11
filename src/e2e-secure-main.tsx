import React from "react";
import { createRoot } from "react-dom/client";
import ZustandFileUpload from "./components/ZustandFileUpload";
import { API_BASE_URL, API_PATHS } from "./config/api";

/**
 * E2E 专用入口（secure 变体）：与 `e2e-main.tsx` 完全一致，仅注入 `getAuthToken`。
 * 令牌取自可变全局 `window.__E2E_TOKEN__`（默认 `e2e-secure-token`），以便
 * `secure.smoke.spec.ts` 在运行时模拟「令牌过期/轮换」——先把全局改成错误令牌触发
 * 401，再改回正确令牌触发重试成功，无需重启后端。
 *
 * 走 `getAuthToken`（而非静态 `authToken`）以避开「静态令牌打进 bundle」的开发期告警。
 */
const ALLOWED_FILE_TYPES: string[] = [];

const SECURE_TOKEN = "e2e-secure-token";
const getAuthToken = (): string =>
  String((window as unknown as { __E2E_TOKEN__?: string }).__E2E_TOKEN__ ?? SECURE_TOKEN);

export const E2ESecureApp: React.FC = () => (
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
    getAuthToken={getAuthToken}
  />
);

createRoot(document.getElementById("root")!).render(<E2ESecureApp />);
