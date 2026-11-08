import { beforeEach, describe, expect, it, vi } from "vitest";
import localforage from "localforage";
import { createUploadStore, type UploadStore } from "./upload";
import type { UploadFile } from "../types/upload";

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

describe("createUploadStore.setProgressDetail（VU-40）", () => {
  it("一次 set 同步更新三张 map，订阅者只收到 1 次通知", () => {
    const store = createUploadStore(
      localforage.createInstance({
        name: "test-progress-detail",
        storeName: "t",
      })
    );
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.getState().setProgressDetail("f1", {
      progress: 42,
      speed: 1024,
      eta: 7,
    });
    unsubscribe();

    expect(notifications).toBe(1);
    const state = store.getState();
    expect(state.progressMap.f1).toBe(42);
    expect(state.speedMap.f1).toBe(1024);
    expect(state.etaMap.f1).toBe(7);
  });

  it("同一文件再次更新只覆盖该文件，其他文件的进度保留", () => {
    const store = createUploadStore(
      localforage.createInstance({
        name: "test-progress-detail-2",
        storeName: "t",
      })
    );
    store.getState().setProgressDetail("f1", {
      progress: 10,
      speed: 100,
      eta: 9,
    });
    store.getState().setProgressDetail("f2", {
      progress: 20,
      speed: 200,
      eta: 8,
    });
    store.getState().setProgressDetail("f1", {
      progress: 99,
      speed: 999,
      eta: 1,
    });

    const state = store.getState();
    expect(state.progressMap).toMatchObject({ f1: 99, f2: 20 });
    expect(state.speedMap).toMatchObject({ f1: 999, f2: 200 });
    expect(state.etaMap).toMatchObject({ f1: 1, f2: 8 });
  });
});

describe("createUploadStore.refreshFiles（VU-18 / VU-39 已知快照刷新）", () => {
  const createCountedStorage = () => {
    const iterate = vi.fn(
      async (_callback: (value: unknown, key: string) => void) => undefined
    );
    return {
      iterate,
      storage: { iterate } as unknown as LocalForage,
    };
  };

  it("传入已知快照时直接采用，完全不 iterate IndexedDB", async () => {
    const { storage, iterate } = createCountedStorage();
    const store = createUploadStore(storage);
    const snapshot = [{ id: "f1" } as UploadFile, { id: "f2" } as UploadFile];

    await store.getState().refreshFiles(snapshot);

    expect(store.getState().files).toBe(snapshot);
    expect(iterate).not.toHaveBeenCalled();
  });

  it("不传快照时才做一次全量对账读", async () => {
    const { storage, iterate } = createCountedStorage();
    const store = createUploadStore(storage);

    await store.getState().refreshFiles();

    expect(iterate).toHaveBeenCalledTimes(1);
    expect(store.getState().files).toEqual([]);
  });
});
