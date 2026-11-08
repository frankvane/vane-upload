import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetSafeStorageCacheForTests,
  safeStorage,
} from "./safeStorage";

/**
 * VU-48：用可计数的假 Storage 验证「探测只做一次」。
 * 不依赖 vi.spyOn 对 jsdom Storage 原型方法的拦截细节。
 */
const makeFakeStorage = (
  onSetItem?: (key: string, value: string) => void,
) => ({
  getItem: vi.fn((_key: string) => null),
  setItem: vi.fn((key: string, value: string) => {
    onSetItem?.(key, value);
  }),
  removeItem: vi.fn(),
  clear: vi.fn(),
  key: vi.fn(),
  length: 0,
});

describe("safeStorage 可用性探测缓存（VU-48）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetSafeStorageCacheForTests();
  });

  it("连续多次读 / 写 / 删只触发 1 次探测写，且业务写入照常", () => {
    const fake = makeFakeStorage();
    vi.stubGlobal("localStorage", fake);
    resetSafeStorageCacheForTests();

    safeStorage.getItem("a", 1);
    safeStorage.getItem("b", 2);
    safeStorage.getItem("c", 3);
    safeStorage.setItem("d", 4);
    safeStorage.removeItem("d");

    const probeWrites = fake.setItem.mock.calls.filter(
      ([key]) => key === "rui:__probe__",
    );
    // 旧实现每次访问都探测：这里应有 6 次；修复后只有 1 次。
    expect(probeWrites).toHaveLength(1);
    expect(fake.setItem.mock.calls.some(([key]) => key === "rui:d")).toBe(true);
  });

  it("探测失败时永久降级，不再反复触写被禁用的存储", () => {
    let probeAttempts = 0;
    const fake = makeFakeStorage(() => {
      probeAttempts += 1;
      throw new Error("blocked");
    });
    vi.stubGlobal("localStorage", fake);
    resetSafeStorageCacheForTests();

    expect(() => safeStorage.setItem("k", 1)).not.toThrow();
    expect(safeStorage.getItem("k", "fb")).toBe("fb");
    safeStorage.removeItem("k");

    expect(probeAttempts).toBe(1);
  });
});
