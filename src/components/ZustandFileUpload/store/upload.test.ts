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

describe("T-07 store 文件对象不可变（原地改写防线）", () => {
  const makeStore = () =>
    createUploadStore(
      localforage.createInstance({ name: "t07-upload-store", storeName: "t07" })
    );

  it("进入 store 的文件对象在开发环境下被冻结，原地改写会抛 TypeError", () => {
    const store = makeStore();
    const file = { id: "f1", status: "queued", progress: 0 } as unknown as UploadFile;

    store.getState().setFiles([file]);

    // 冻结是「兜底」而非唯一防线：真正的修法是调用方复制 draft。
    // 但只要有人改回原地改写，这里会立刻炸出具体字段，而不是悄悄错帧。
    expect(Object.isFrozen(store.getState().files[0])).toBe(true);
    expect(() => {
      (store.getState().files[0] as { status: string }).status = "error";
    }).toThrow(TypeError);
  });

  it("patchFile 生成新数组与新元素（订阅者才会收到通知）", () => {
    const store = makeStore();
    const file = { id: "f1", status: "queued", progress: 0 } as unknown as UploadFile;
    store.getState().setFiles([file]);
    const beforeFiles = store.getState().files;

    // 模拟订阅：选择首个元素，引用变化才重渲染
    let renders = 0;
    const unsubscribe = store.subscribe((state) => {
      if (state.files[0] !== beforeFiles[0]) {
        renders += 1;
      }
    });

    store.getState().patchFile("f1", { progress: 50 });
    unsubscribe();

    expect(renders).toBe(1);
    expect(store.getState().files).not.toBe(beforeFiles);
    expect(store.getState().files[0]).not.toBe(file);
    expect(store.getState().files[0]!.progress).toBe(50);
    // 原对象未被顺手改（否则引用不变，上面的 renders 会是 0）
    expect(file.progress).toBe(0);
  });
});
