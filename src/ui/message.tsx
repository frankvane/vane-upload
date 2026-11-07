/**
 * rui-ui message 轻提示（替代 antd 静态 message）。
 *
 * 与 antd 的差异（精减模式）：
 * - 仅支持 success / error / warning / info 四类（调用点只用这四类）；
 * - 无 update/关闭句柄/最长存活等特性；
 * - 支持 `setMessageApi` 注入（上传侧 store 已有注入层，语义不变）。
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  InfoCircleOutlined,
  WarningOutlined,
} from "./icons";

export type MessageType = "success" | "error" | "warning" | "info" | "loading";

export interface MessageInstance {
  success: (content: React.ReactNode) => void;
  error: (content: React.ReactNode) => void;
  warning: (content: React.ReactNode) => void;
  info: (content: React.ReactNode) => void;
}

const DURATION = 3000;
const canDOM = typeof document !== "undefined";

let uid = 0;
let container: HTMLDivElement | null = null;
let root: Root | null = null;
const notices = new Map<number, { type: MessageType; content: React.ReactNode }>();

const render = () => {
  if (!root) return;
  root.render(
    <div className="rui-message">
      {[...notices.entries()].map(([key, notice]) => (
        <div
          key={key}
          className={`rui-message-notice rui-message-${notice.type}`}
          role="alert"
        >
          <span className="rui-message-icon" aria-hidden="true">
            {notice.type === "success" && <CheckCircleOutlined />}
            {notice.type === "error" && <CloseCircleOutlined />}
            {notice.type === "warning" && <WarningOutlined />}
            {notice.type === "info" && <InfoCircleOutlined />}
            {notice.type === "loading" && (
              <span className="rui-spin rui-spin-sm" />
            )}
          </span>
          <span>{notice.content}</span>
        </div>
      ))}
    </div>,
  );
};

const remove = (key: number) => {
  notices.delete(key);
  render();
  if (notices.size === 0 && container && root) {
    root.unmount();
    root = null;
    container.remove();
    container = null;
  }
};

const push = (type: MessageType, content: React.ReactNode, duration = DURATION) => {
  if (!canDOM) return;
  const key = ++uid;
  if (!container) {
    container = document.createElement("div");
    container.className = "rui-message-host";
    document.body.appendChild(container);
    root = createRoot(container);
  }
  notices.set(key, { type, content });
  render();
  window.setTimeout(() => remove(key), duration);
};

export const message: MessageInstance & {
  destroy: () => void;
} = {
  success: (content) => push("success", content),
  error: (content) => push("error", content),
  warning: (content) => push("warning", content),
  info: (content) => push("info", content),
  destroy: () => {
    notices.clear();
    if (root) root.unmount();
    root = null;
    if (container) container.remove();
    container = null;
  },
};

export type { MessageInstance as MessageInstanceType };
