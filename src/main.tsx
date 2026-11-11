import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// VU-46：应用入口唯一一次样式引入（库入口 src/index.ts 另引入一次，产物各自只有一份）。
import "./ui/ui.css";
import App from "./App.tsx";

// 仅开发环境：挂载「测试文件注入口」，供浏览器模式回归时绕过原生文件选择框。
// 生产构建 import.meta.env.DEV 为 false，本块及其依赖会被完全摇树移除。
if (import.meta.env.DEV) {
  // T-77：react-dom/client 已在 :2 静态导入，嵌套再动态 import 一次既重复
  // 拉取、也让 dev 面板挂载多一跳。直接复用顶部导入的 createRoot。
  void import("./dev/fileInjectionPanel").then(({ default: Panel }) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    createRoot(host).render(<Panel />);
  });
}

// VU-22：启用 StrictMode。引擎资源（workerPool / fileRegistry）在 cleanup 中释放，
// 但 runUploadTask 按需惰性重建 worker，故双调用下上传可自愈，不影响运行期。
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
