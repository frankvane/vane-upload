import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useNetwork } from "./useNetwork";

interface MockConnection extends EventTarget {
  rtt?: number;
  type?: string;
  effectiveType?: string;
}

const mockConnection = (props: Partial<MockConnection> = {}) => {
  const connection = new EventTarget() as MockConnection;
  Object.assign(connection, {
    rtt: 50,
    type: "wifi",
    effectiveType: "4g",
    ...props,
  });
  Object.defineProperty(navigator, "connection", {
    value: connection,
    configurable: true,
  });
  return connection;
};

afterEach(() => {
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "connection");
  vi.restoreAllMocks();
});

describe("useNetwork（替代 ahooks useNetwork，T4.2）", () => {
  it("初始值：navigator.onLine + connection 属性快照", () => {
    mockConnection({ rtt: 120, type: "cellular", effectiveType: "3g" });

    const { result } = renderHook(() => useNetwork());

    expect(result.current).toEqual({
      online: true,
      rtt: 120,
      type: "cellular",
      effectiveType: "3g",
    });
  });

  it("无 connection API 时仅上报 online，其余字段 undefined", () => {
    const { result } = renderHook(() => useNetwork());

    expect(result.current).toEqual({
      online: true,
      rtt: undefined,
      type: undefined,
      effectiveType: undefined,
    });
  });

  it("online / offline 事件翻转 online 状态", () => {
    const { result } = renderHook(() => useNetwork());

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current.online).toBe(false);

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current.online).toBe(true);
  });

  it("connection change 事件刷新 rtt/type/effectiveType", () => {
    const connection = mockConnection();

    const { result } = renderHook(() => useNetwork());
    expect(result.current.rtt).toBe(50);

    connection.rtt = 250;
    connection.effectiveType = "2g";
    act(() => {
      connection.dispatchEvent(new Event("change"));
    });

    expect(result.current.rtt).toBe(250);
    expect(result.current.effectiveType).toBe("2g");
    expect(result.current.online).toBe(true);
  });

  it("卸载时移除全部事件监听", () => {
    const connection = mockConnection();
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const connectionRemoveSpy = vi.spyOn(connection, "removeEventListener");

    const { unmount } = renderHook(() => useNetwork());
    unmount();

    expect(removeSpy).toHaveBeenCalledWith("online", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("offline", expect.any(Function));
    expect(connectionRemoveSpy).toHaveBeenCalledWith(
      "change",
      expect.any(Function)
    );
  });

  it("VU-44：3 个实例共享一套 passive 监听，最后一个卸载才注销", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const onlineAdds = () =>
      addSpy.mock.calls.filter(([type]) => type === "online");
    const onlineRemoves = () =>
      removeSpy.mock.calls.filter(([type]) => type === "online");

    const first = renderHook(() => useNetwork());
    const second = renderHook(() => useNetwork());
    const third = renderHook(() => useNetwork());

    // 无论挂载几个实例，window 上只有一套 online/offline 监听
    expect(onlineAdds()).toHaveLength(1);
    expect(onlineAdds()[0]?.[2]).toMatchObject({ passive: true });
    expect(
      addSpy.mock.calls.filter(([type]) => type === "offline")
    ).toHaveLength(1);

    // 部分卸载不应注销共享监听，也不应重复注册
    first.unmount();
    second.unmount();
    expect(onlineRemoves()).toHaveLength(0);
    expect(onlineAdds()).toHaveLength(1);

    // 剩余的订阅者仍能收到广播
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(third.result.current.online).toBe(false);

    third.unmount();
    expect(onlineRemoves()).toHaveLength(1);
    expect(
      removeSpy.mock.calls.filter(([type]) => type === "offline")
    ).toHaveLength(1);

    // 全部卸载后派发事件：监听已注销，不会写回单例快照；
    // 重新挂载时按 ref-count 冷启动重新注册，初值取自当前 navigator.onLine。
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    const fresh = renderHook(() => useNetwork());
    expect(onlineAdds()).toHaveLength(2);
    expect(fresh.result.current.online).toBe(navigator.onLine);
    fresh.unmount();

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
