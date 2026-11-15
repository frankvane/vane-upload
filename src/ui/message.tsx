/**
 * rui-ui message 轻提示（替代 antd 静态 message）。
 *
 * 与 antd 的差异（精减模式）：
 * - 仅支持 success / error / warning / info 四类（调用点只用这四类）；
 * - 无 update/关闭句柄/最长存活等特性；
 * - 支持 `setMessageApi` 注入（上传侧 store 已有注入层，语义不变）。
 * - 同屏最多保留 3 条（MAX_NOTICES），超出淘汰最早一条，避免连续操作刷屏。
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
/**
 * 消息等级（给上传组件等宿主做「提示降噪」）：
 * - `all`：全部放行（默认，保持既有行为）；
 * - `warning-error`：仅放行 warning / error，成功与 info 静默；
 * - `none`：全部静默。
 */
export type MessageLevel = "all" | "warning-error" | "none";

export interface MessageInstance {
  success: (content: React.ReactNode) => void;
  error: (content: React.ReactNode) => void;
  warning: (content: React.ReactNode) => void;
  info: (content: React.ReactNode) => void;
}

const DURATION = 3000;
/** 同屏提示上限：满了以后淘汰最早的一条（连同它的定时器）。 */
const MAX_NOTICES = 3;
const canDOM = typeof document !== "undefined";

let uid = 0;
let container: HTMLDivElement | null = null;
let root: Root | null = null;
interface NoticeEntry {
  type: MessageType;
  content: React.ReactNode;
  timer: number;
}
const notices = new Map<number, NoticeEntry>();

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
  const entry = notices.get(key);
  if (entry) window.clearTimeout(entry.timer);
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
  notices.set(key, { type, content, timer: 0 });
  // Map 保持插入顺序，keys().next() 即最早一条；淘汰时一并清掉它的定时器。
  while (notices.size > MAX_NOTICES) {
    const oldestKey = notices.keys().next().value as number | undefined;
    if (oldestKey === undefined) break;
    const oldest = notices.get(oldestKey);
    if (oldest) window.clearTimeout(oldest.timer);
    notices.delete(oldestKey);
  }
  render();
  const timer = window.setTimeout(() => remove(key), duration);
  const entry = notices.get(key);
  if (entry) entry.timer = timer;
};

const noop = () => {};

/**
 * 按等级包装消息 API。供上传组件 store 在 `getMessageApi()` 里按配置调用：
 * 所有库内提示都经该出口，故此处一处过滤即可全量生效，调用点无需改动。
 * 未传 `level`（undefined）时按 `all` 处理，保持既有行为与三方集成兼容。
 */
export const createLeveledMessageApi = (
  base: MessageInstance,
  level: MessageLevel = "all",
): MessageInstance => {
  if (level === "all") return base;
  if (level === "none") {
    return { success: noop, error: noop, warning: noop, info: noop };
  }
  // warning-error：只放行错误与警告，成功 / info 静默。
  return {
    success: noop,
    info: noop,
    error: (content) => base.error(content),
    warning: (content) => base.warning(content),
  };
};

export const message: MessageInstance & {
  destroy: () => void;
} = {
  success: (content) => push("success", content),
  error: (content) => push("error", content),
  warning: (content) => push("warning", content),
  info: (content) => push("info", content),
  destroy: () => {
    for (const entry of notices.values()) window.clearTimeout(entry.timer);
    notices.clear();
    if (root) root.unmount();
    root = null;
    if (container) container.remove();
    container = null;
  },
};

export type { MessageInstance as MessageInstanceType };
