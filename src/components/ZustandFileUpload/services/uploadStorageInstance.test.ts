import { describe, it, expect, vi } from "vitest";
import localforage from "localforage";
import type LocalForage from "localforage";

import {
  DEFAULT_UPLOAD_DB_NAME,
  DEFAULT_UPLOAD_STORE_NAME,
  createUploadStorage,
} from "./uploadStorageInstance";

describe("createUploadStorage 常量", () => {
  it("导出默认 DB 名与 store 名", () => {
    expect(DEFAULT_UPLOAD_DB_NAME).toBe("react-upload-indexeddb");
    expect(DEFAULT_UPLOAD_STORE_NAME).toBe("upload_files");
  });
});

describe("createUploadStorage 实例接口", () => {
  it("返回对象具备 setItem/getItem/removeItem 方法", () => {
    const storage = createUploadStorage();
    expect(typeof storage.setItem).toBe("function");
    expect(typeof storage.getItem).toBe("function");
    expect(typeof storage.removeItem).toBe("function");
  });

  it("可在 fake-indexeddb 下真实读写并取回数据", async () => {
    const storage = createUploadStorage("rw-test");
    await storage.setItem("k1", { name: "alpha" });
    const got = await storage.getItem<{ name: string }>("k1");
    expect(got).not.toBeNull();
    expect(got?.name).toBe("alpha");
  });

  it("removeItem 能删除已写入的项", async () => {
    const storage = createUploadStorage("rw-del");
    await storage.setItem("k2", { v: 1 });
    expect(await storage.getItem("k2")).not.toBeNull();
    await storage.removeItem("k2");
    expect(await storage.getItem("k2")).toBeNull();
  });

  it("写入的元数据自动盖章 schemaVersion", async () => {
    const storage = createUploadStorage("rw-schema");
    await storage.setItem("k3", { id: "f1" } as never);
    const raw = await storage.getItem<{ schemaVersion?: number }>("k3");
    expect(raw?.schemaVersion).toBe(2);
  });
});

describe("createUploadStorage 实例隔离", () => {
  it("不传 instanceId 时回落到默认 store 名", () => {
    const storage = createUploadStorage();
    expect(storage.config("storeName")).toBe(DEFAULT_UPLOAD_STORE_NAME);
  });

  it("不同 instanceId 对应不同 store 名", () => {
    const a = createUploadStorage("instanceA");
    const b = createUploadStorage("instanceB");
    expect(a.config("storeName")).toBe(`${DEFAULT_UPLOAD_STORE_NAME}_instanceA`);
    expect(b.config("storeName")).toBe(`${DEFAULT_UPLOAD_STORE_NAME}_instanceB`);
    expect(a.config("storeName")).not.toBe(b.config("storeName"));
  });

  it("所有实例共享同一 DB 名（react-upload-indexeddb）", () => {
    const a = createUploadStorage("instanceA");
    const b = createUploadStorage();
    expect(a.config("name")).toBe(DEFAULT_UPLOAD_DB_NAME);
    expect(b.config("name")).toBe(DEFAULT_UPLOAD_DB_NAME);
  });

  it("不同实例写入互不串数据", async () => {
    const a = createUploadStorage("isoA") as LocalForage;
    const b = createUploadStorage("isoB") as LocalForage;
    await a.setItem("sameKey", { from: "A" });
    await b.setItem("sameKey", { from: "B" });
    const fromA = await a.getItem<{ from: string }>("sameKey");
    const fromB = await b.getItem<{ from: string }>("sameKey");
    expect(fromA?.from).toBe("A");
    expect(fromB?.from).toBe("B");
  });
});

describe("T-66：代理转发到同一底层连接（不分裂）", () => {
  it("setItem/getItem/removeItem/iterate 都委托给同一底层实例", () => {
    const setItem = vi.fn();
    const getItem = vi.fn();
    const removeItem = vi.fn();
    const iterate = vi.fn();
    const fakeStore = {
      setItem,
      getItem,
      removeItem,
      iterate,
    } as unknown as LocalForage;
    const createSpy = vi
      .spyOn(localforage, "createInstance")
      .mockReturnValue(fakeStore);

    const storage = createUploadStorage("delegate-test");
    storage.setItem("k", { a: 1 });
    storage.getItem("k");
    storage.removeItem("k");
    storage.iterate(() => undefined);

    // 四个方法都调用到底层同一实例的对应方法（同一连接，无代理分裂）
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(removeItem).toHaveBeenCalledTimes(1);
    expect(iterate).toHaveBeenCalledTimes(1);
    createSpy.mockRestore();
  });
});
