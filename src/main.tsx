import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// VU-46：应用入口唯一一次样式引入（库入口 src/index.ts 另引入一次，产物各自只有一份）。
import "./ui/ui.css";
import App from "./App.tsx";

// VU-22：启用 StrictMode。引擎资源（workerPool / fileRegistry）在 cleanup 中释放，
// 但 runUploadTask 按需惰性重建 worker，故双调用下上传可自愈，不影响运行期。
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
