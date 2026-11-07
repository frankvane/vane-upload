import { beforeEach, describe, expect, it } from "vitest";
import localforage from "localforage";
import { createUploadStore, type UploadStore } from "./upload";

describe("createUploadStore.initSettings", () => {
  let store: UploadStore;

  beforeEach(() => {
    localStorage.clear();
    // T3.2：store 不再为模块级单例，而是 createUploadStore 工厂产物；
    // 每个用例持独立仓库（storage 仅占位，本组用例不触发 refreshFiles）。
    store = createUploadStore(
      localforage.createInstance({ name: "test-upload-store", storeName: "t" })
    );
    store.setState({
      autoUpload: true,
      autoCleanup: true,
      cleanupDelay: 10,
      networkDisplayMode: "tooltip",
    });
  });

  it("reads persisted values when settingsSource is localStorage", () => {
    localStorage.setItem("autoUpload", JSON.stringify(false));
    localStorage.setItem("autoCleanup", JSON.stringify(false));
    localStorage.setItem("cleanupDelay", JSON.stringify(22));
    localStorage.setItem("networkDisplayMode", "direct");

    store.getState().initSettings({
      autoUpload: true,
      autoCleanup: true,
      cleanupDelay: 5,
      networkDisplayMode: "tooltip",
      settingsSource: "localStorage",
    });

    const state = store.getState();
    expect(state.autoUpload).toBe(false);
    expect(state.autoCleanup).toBe(false);
    expect(state.cleanupDelay).toBe(22);
    expect(state.networkDisplayMode).toBe("direct");
  });

  it("uses provided defaults when settingsSource is props", () => {
    localStorage.setItem("autoUpload", JSON.stringify(false));
    localStorage.setItem("autoCleanup", JSON.stringify(false));
    localStorage.setItem("cleanupDelay", JSON.stringify(30));
    localStorage.setItem("networkDisplayMode", "direct");

    store.getState().initSettings({
      autoUpload: true,
      autoCleanup: true,
      cleanupDelay: 5,
      networkDisplayMode: "tooltip",
      settingsSource: "props",
    });

    const state = store.getState();
    expect(state.autoUpload).toBe(true);
    expect(state.autoCleanup).toBe(true);
    expect(state.cleanupDelay).toBe(5);
    expect(state.networkDisplayMode).toBe("tooltip");
  });

  it("reads rui:-prefixed persisted values (F1 命名空间)", () => {
    // F1：safeStorage 写入带 rui: 前缀，读取也应命中该前缀
    localStorage.setItem("rui:autoUpload", JSON.stringify(false));
    localStorage.setItem("rui:cleanupDelay", JSON.stringify(22));
    localStorage.setItem("rui:networkDisplayMode", JSON.stringify("direct"));

    store.getState().initSettings({ settingsSource: "localStorage" });

    const state = store.getState();
    expect(state.autoUpload).toBe(false);
    expect(state.cleanupDelay).toBe(22);
    expect(state.networkDisplayMode).toBe("direct");
  });

  it("does not throw on corrupt localStorage JSON (F1 异常保护)", () => {
    localStorage.setItem("rui:autoUpload", "{bad-json");
    localStorage.setItem("rui:cleanupDelay", "not-a-number");

    expect(() =>
      store.getState().initSettings({ settingsSource: "localStorage" })
    ).not.toThrow();

    // 损坏数据 → 回落到默认值，而非崩溃
    const state = store.getState();
    expect(state.autoUpload).toBe(true);
    expect(state.cleanupDelay).toBe(10);
  });
});
