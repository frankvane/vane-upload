import { describe, it, expect } from "vitest";

import { createFileRegistry } from "./fileRegistry";

const makeFile = (name: string) =>
  new File([new Uint8Array([1, 2, 3])], name, { type: "text/plain" });

describe("createFileRegistry 登记/查找", () => {
  it("registerFileRef + getFileRef 能取回同一引用", () => {
    const reg = createFileRegistry();
    const file = makeFile("a.txt");
    reg.registerFileRef("id-1", file);
    expect(reg.getFileRef("id-1")).toBe(file);
  });

  it("未登记时 getFileRef 返回 undefined", () => {
    const reg = createFileRegistry();
    expect(reg.getFileRef("missing")).toBeUndefined();
  });

  it("fileRefCount 反映当前登记数量", () => {
    const reg = createFileRegistry();
    expect(reg.fileRefCount()).toBe(0);
    reg.registerFileRef("a", makeFile("a.txt"));
    reg.registerFileRef("b", makeFile("b.txt"));
    expect(reg.fileRefCount()).toBe(2);
  });

  it("同 id 重复登记以最新为准", () => {
    const reg = createFileRegistry();
    const f1 = makeFile("first.txt");
    const f2 = makeFile("second.txt");
    reg.registerFileRef("dup", f1);
    reg.registerFileRef("dup", f2);
    expect(reg.fileRefCount()).toBe(1);
    expect(reg.getFileRef("dup")).toBe(f2);
  });
});

describe("createFileRegistry 释放", () => {
  it("releaseFileRef 移除单个引用", () => {
    const reg = createFileRegistry();
    reg.registerFileRef("a", makeFile("a.txt"));
    reg.registerFileRef("b", makeFile("b.txt"));
    reg.releaseFileRef("a");
    expect(reg.getFileRef("a")).toBeUndefined();
    expect(reg.getFileRef("b")).not.toBeUndefined();
    expect(reg.fileRefCount()).toBe(1);
  });

  it("releaseAllFileRefs 清空全部引用", () => {
    const reg = createFileRegistry();
    reg.registerFileRef("a", makeFile("a.txt"));
    reg.registerFileRef("b", makeFile("b.txt"));
    reg.releaseAllFileRefs();
    expect(reg.fileRefCount()).toBe(0);
    expect(reg.getFileRef("a")).toBeUndefined();
    expect(reg.getFileRef("b")).toBeUndefined();
  });

  it("释放不存在的 id 不报错且数量不变", () => {
    const reg = createFileRegistry();
    reg.registerFileRef("a", makeFile("a.txt"));
    expect(() => reg.releaseFileRef("ghost")).not.toThrow();
    expect(reg.fileRefCount()).toBe(1);
  });
});

describe("createFileRegistry 实例隔离", () => {
  it("两个独立注册表互不干扰", () => {
    const reg1 = createFileRegistry();
    const reg2 = createFileRegistry();
    const file = makeFile("shared.txt");
    reg1.registerFileRef("x", file);
    expect(reg2.getFileRef("x")).toBeUndefined();
    expect(reg1.getFileRef("x")).toBe(file);
  });
});
