import React from "react";
import ZustandFileUpload from "../components/ZustandFileUpload";
import { API_BASE_URL, API_PATHS } from "../config/api";

/**
 * demo 专用：纯属性演示上传组件的精简外观。
 * `uiMode="simple"` 负责裁剪表格/工具栏，`settingsSource="props"` 让网络参数
 * 只跟随 props，避免 demo 修改本地存储中的默认设置。
 */
const SimpleUploadDemo: React.FC = () => (
  <ZustandFileUpload
    baseURL={API_BASE_URL}
    uploadApi={API_PATHS.file.upload}
    checkApi={API_PATHS.file.instant}
    chunkSize={1024 * 1024}
    fileConcurrency={2}
    chunkConcurrency={2}
    maxRetries={3}
    maxFileSize={100 * 1024 * 1024}
    allowedFileTypes={[]}
    maxFiles={10}
    autoUpload={true}
    autoCleanup={true}
    cleanupDelay={5}
    networkDisplayMode="tooltip"
    uiMode="simple"
    settingsSource="props"
  />
);

export default SimpleUploadDemo;
