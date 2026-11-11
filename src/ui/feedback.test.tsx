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

describe("Tooltip a11y（T-70）", () => {
  it("合并子元素既有事件，不覆盖其 onClick", () => {
    const onClick = vi.fn();
    render(
      <Tooltip title="提示">
        <button onClick={onClick}>目标</button>
      </Tooltip>,
    );
    fireEvent.click(screen.getByText("目标"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("可见时触发器带 aria-describedby 指向 tooltip id", () => {
    vi.useFakeTimers();
    try {
      render(
        <Tooltip title="提示内容">
          <button>目标</button>
        </Tooltip>,
      );
      const btn = screen.getByText("目标");
      fireEvent.mouseEnter(btn);
      act(() => {
        vi.advanceTimersByTime(150);
      });
      const describedby = btn.getAttribute("aria-describedby");
      expect(describedby).toBeTruthy();
      const tip = document.getElementById(describedby!);
      expect(tip).not.toBeNull();
      expect(tip!.getAttribute("role")).toBe("tooltip");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ESC 关闭可见 tooltip", () => {
    vi.useFakeTimers();
    try {
      render(
        <Tooltip title="提示内容">
          <button>目标</button>
        </Tooltip>,
      );
      fireEvent.mouseEnter(screen.getByText("目标"));
      act(() => {
        vi.advanceTimersByTime(150);
      });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
      act(() => {
        fireEvent.keyDown(document, { key: "Escape" });
      });
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Modal / Drawer 焦点管理（T-70）", () => {
  it("Modal 打开后焦点移入对话框，关闭后归还来源焦点", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "打开";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(
      <Modal open onCancel={vi.fn()}>
        内容
      </Modal>,
    );
    expect(document.querySelector(".rui-modal")).toHaveFocus();

    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("Modal 内 Tab 循环，焦点不逃出 panel", () => {
    render(
      <Modal open onCancel={vi.fn()}>
        <button>第一个</button>
        <button>第二个</button>
      </Modal>,
    );
    const dialog = document.querySelector(".rui-modal") as HTMLElement;
    const buttons = Array.from(dialog.querySelectorAll("button"));
    // 聚焦最后一个可聚焦元素，Tab 应回到第一个（圈禁）
    buttons[buttons.length - 1].focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(buttons[0]).toHaveFocus();
  });

  it("Drawer 内 Tab 循环，焦点不逃出 panel", () => {
    render(
      <Drawer open title="抽屉" onClose={vi.fn()}>
        <button>甲</button>
        <button>乙</button>
      </Drawer>,
    );
    const panel = document.querySelector(".rui-drawer") as HTMLElement;
    const buttons = Array.from(panel.querySelectorAll("button"));
    buttons[buttons.length - 1].focus();
    fireEvent.keyDown(panel, { key: "Tab" });
    expect(buttons[0]).toHaveFocus();
  });
});
