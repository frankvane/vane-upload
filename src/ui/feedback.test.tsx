import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./feedback";

/**
 * VU-30：ModalInner 的 ESC 监听注册在 useEffect([]) 中，旧实现直接闭包捕获
 * 首次渲染的 onCancel；父组件重渲染传入新回调后，ESC 仍调用过期闭包，
 * 弹窗可能永远关不掉。改用 ref 读取最新回调后，这里锁定行为不变式。
 */
describe("Modal ESC 监听（VU-30）", () => {
  it("挂载后替换 onCancel，ESC 调用的是最新回调而非首次闭包", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(
      <Modal open title="提示" onCancel={first}>
        内容
      </Modal>,
    );

    rerender(
      <Modal open title="提示" onCancel={latest}>
        内容
      </Modal>,
    );
    fireEvent.keyDown(document, { key: "Escape" });

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it("非 Escape 按键不触发 onCancel", () => {
    const onCancel = vi.fn();
    render(
      <Modal open onCancel={onCancel}>
        内容
      </Modal>,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("卸载后监听器被移除，不再响应 ESC", () => {
    const onCancel = vi.fn();
    const { unmount } = render(
      <Modal open onCancel={onCancel}>
        内容
      </Modal>,
    );
    unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("VU-44：多个浮层同时打开时 ESC 只关闭最上层", () => {
    const lower = vi.fn();
    const upper = vi.fn();
    render(
      <>
        <Modal open title="下层" onCancel={lower}>
          下层内容
        </Modal>
        <Modal open title="上层" onCancel={upper}>
          上层内容
        </Modal>
      </>,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
  });
});
