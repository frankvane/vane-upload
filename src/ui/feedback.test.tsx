import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Drawer, Modal, Tooltip } from "./feedback";

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

describe("T-70 Tooltip a11y", () => {
  /** show 有 150ms 延迟，测试内统一用假定时器推进 */
  const openTooltip = (trigger: HTMLElement) => {
    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(150);
    });
  };

  it("浮层带 id、触发元素经 aria-describedby 关联，ESC 可关闭", () => {
    vi.useFakeTimers();
    try {
      render(
        <Tooltip title="提示文案">
          <button type="button">触发</button>
        </Tooltip>,
      );
      const trigger = screen.getByRole("button", { name: "触发" });
      expect(trigger.getAttribute("aria-describedby")).toBeNull();

      openTooltip(trigger);
      const tip = document.querySelector('[role="tooltip"]')!;
      expect(tip).not.toBeNull();
      const id = tip.getAttribute("id");
      expect(id).toBeTruthy();
      expect(trigger.getAttribute("aria-describedby")).toBe(id);

      fireEvent.keyDown(document, { key: "Escape" });
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      expect(trigger.getAttribute("aria-describedby")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cloneElement 不覆盖子元素自带的同名事件（且内部定位仍生效）", () => {
    vi.useFakeTimers();
    try {
      const onFocus = vi.fn();
      const onMouseEnter = vi.fn();
      const onMouseLeave = vi.fn();
      render(
        <Tooltip title="提示">
          <button
            type="button"
            onFocus={onFocus}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
          >
            触发
          </button>
        </Tooltip>,
      );
      const trigger = screen.getByRole("button", { name: "触发" });

      fireEvent.focus(trigger);
      expect(onFocus).toHaveBeenCalledTimes(1);
      fireEvent.mouseEnter(trigger);
      expect(onMouseEnter).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(150);
      });
      // 浮层出现说明 Tooltip 内部 ref 定位依然有效
      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();

      fireEvent.mouseLeave(trigger);
      expect(onMouseLeave).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("T-70 Modal / Drawer 焦点管理", () => {
  it("Modal 关闭（卸载）时把焦点归还打开前的元素", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "打开弹窗";
    document.body.appendChild(trigger);
    try {
      trigger.focus();
      const { rerender } = render(<Modal open title="弹窗">内容</Modal>);
      const dialog = document.querySelector(".rui-modal") as HTMLElement;
      expect(document.activeElement).toBe(dialog);

      rerender(
        <Modal open={false} title="弹窗">
          内容
        </Modal>,
      );
      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });

  it("Drawer 打开移入焦点、关闭归还来源焦点", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "打开抽屉";
    document.body.appendChild(trigger);
    try {
      trigger.focus();
      const { rerender } = render(<Drawer open={false} title="抽屉" />);
      rerender(
        <Drawer open title="抽屉">
          <button type="button">A</button>
        </Drawer>,
      );
      const panel = document.querySelector(".rui-drawer") as HTMLElement;
      expect(document.activeElement).toBe(panel);

      rerender(<Drawer open={false} title="抽屉" />);
      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });

  it("Tab 不逃出面板：末尾→首位、首位 Shift+Tab→末尾", () => {
    render(
      <Drawer open title="抽屉">
        <button type="button">A</button>
        <button type="button">B</button>
      </Drawer>,
    );
    const panel = document.querySelector(".rui-drawer") as HTMLElement;
    const buttons = Array.from(panel.querySelectorAll("button"));
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    expect(buttons.length).toBeGreaterThan(1);

    last.focus();
    fireEvent.keyDown(panel, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(panel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
