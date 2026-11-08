import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { getEscapeHandlerCount, registerEscapeHandler } from "./escapeStack";

describe("VU-44 浮层 ESC 监听单例", () => {
  it("多个浮层共用一个 passive keydown 监听，ESC 只派发给栈顶", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const lower = vi.fn();
    const upper = vi.fn();

    const unregisterLower = registerEscapeHandler(lower);
    const unregisterUpper = registerEscapeHandler(upper);

    const keydownAdds = addSpy.mock.calls.filter(([type]) => type === "keydown");
    expect(keydownAdds).toHaveLength(1);
    expect(keydownAdds[0]?.[2]).toMatchObject({ passive: true });
    expect(getEscapeHandlerCount()).toBe(2);

    fireEvent.keyDown(document, { key: "Enter" });
    expect(lower).not.toHaveBeenCalled();
    expect(upper).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();

    // 栈顶关闭后，ESC 才落到下一层
    unregisterUpper();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(lower).toHaveBeenCalledTimes(1);

    // 最后一个浮层卸载才真正注销 document 监听
    expect(removeSpy.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(0);
    unregisterLower();
    expect(getEscapeHandlerCount()).toBe(0);
    expect(removeSpy.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);

    // 注销后 ESC 不再触发任何回调
    fireEvent.keyDown(document, { key: "Escape" });
    expect(lower).toHaveBeenCalledTimes(1);
    expect(upper).toHaveBeenCalledTimes(1);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
