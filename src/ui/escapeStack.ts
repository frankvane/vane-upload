/**
 * VU-44：浮层 ESC 监听的模块级单例。
 *
 * 旧实现里 Popconfirm / ModalInner / Drawer 各自 `document.addEventListener("keydown")`，
 * 每打开一个浮层就多一套常驻监听，且多个浮层同时打开时一次 ESC 会把它们全部关闭。
 * 这里用一个 ref-count 的处理器栈：首个浮层注册唯一的 passive 监听，最后一个浮层
 * 卸载时注销；ESC 只派发给栈顶（最近打开的浮层）。
 */
type EscapeHandler = () => void;

const handlers: EscapeHandler[] = [];
let attached = false;

const onKeyDown = (event: KeyboardEvent): void => {
  if (event.key !== "Escape") {
    return;
  }
  handlers[handlers.length - 1]?.();
};

/** 注册一个浮层的 ESC 回调，返回注销函数。 */
export const registerEscapeHandler = (handler: EscapeHandler): (() => void) => {
  handlers.push(handler);
  if (!attached && typeof document !== "undefined") {
    // 处理器不调用 preventDefault，声明 passive 让浏览器免去可取消性检查。
    document.addEventListener("keydown", onKeyDown, { passive: true });
    attached = true;
  }

  return () => {
    const index = handlers.lastIndexOf(handler);
    if (index >= 0) {
      handlers.splice(index, 1);
    }
    if (handlers.length === 0 && attached) {
      document.removeEventListener("keydown", onKeyDown);
      attached = false;
    }
  };
};

/** 仅供测试断言：当前活跃浮层数（不暴露内部数组）。 */
export const getEscapeHandlerCount = (): number => handlers.length;
