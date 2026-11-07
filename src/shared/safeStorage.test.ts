import { afterEach, describe, expect, it, vi } from "vitest";
import { safeStorage } from "./safeStorage";

describe("safeStorage（F1）", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("读取不存在的 key 返回 fallback", () => {
    expect(safeStorage.getItem("missing", "def")).toBe("def");
    expect(safeStorage.getItem("missing-num", 7)).toBe(7);
  });

  it("读取 rui: 前缀写入的值并正确解析", () => {
    safeStorage.setItem("autoUpload", false);
    expect(localStorage.getItem("rui:autoUpload")).toBe(JSON.stringify(false));
    expect(safeStorage.getItem("autoUpload", true)).toBe(false);
  });

  it("向前兼容：回退读取无前缀旧 key", () => {
    localStorage.setItem("autoUpload", JSON.stringify(false));
    expect(safeStorage.getItem("autoUpload", true)).toBe(false);
  });

  it("损坏 JSON 返回 fallback 且不抛出", () => {
    localStorage.setItem("rui:autoUpload", "{not-json");
    expect(safeStorage.getItem("autoUpload", true)).toBe(true);
  });

  it("兼容旧版裸写原生字符串（未 JSON 编码）", () => {
    // 早期版本曾将字符串偏好直接写入（如 networkDisplayMode），未做 JSON 编码
    localStorage.setItem("networkDisplayMode", "direct");
    expect(safeStorage.getItem("networkDisplayMode", "tooltip")).toBe("direct");
  });

  it("类型与 fallback 不一致视为损坏，返回 fallback", () => {
    // 直接塞入一个类型不符的值（绕过 setItem 的类型化写入）
    localStorage.setItem("rui:cleanupDelay", JSON.stringify("oops"));
    expect(safeStorage.getItem("cleanupDelay", 10)).toBe(10);
  });

  it("localStorage 不可用时安全降级为 fallback 且不抛出", () => {
    const spy = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(() => safeStorage.setItem("k", 1)).not.toThrow();
    // 探测失败 → 读取也降级
    expect(safeStorage.getItem("k", "fb")).toBe("fb");
    spy.mockRestore();
  });

  it("removeItem 清理前缀与旧 key", () => {
    safeStorage.setItem("k", 1);
    localStorage.setItem("k", JSON.stringify(2));
    safeStorage.removeItem("k");
    expect(localStorage.getItem("rui:k")).toBeNull();
    expect(localStorage.getItem("k")).toBeNull();
  });
});
