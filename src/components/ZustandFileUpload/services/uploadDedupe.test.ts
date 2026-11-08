import { describe, expect, it } from "vitest";
import {
  buildContentKey,
  dedupeByContentKey,
  type ContentKeyed,
} from "./uploadDedupe";

const makeItem = (
  id: string,
  over: Partial<ContentKeyed> = {}
): ContentKeyed & { id: string } => ({
  id,
  hash: "h1",
  fileSize: 1024,
  lastModified: 1700000000000,
  fileName: "a.bin",
  ...over,
});

describe("uploadDedupe（VU-19 重复文件去重）", () => {
  it("buildContentKey 以内容指纹（非 id）为基准，同内容不同 id 仍视为重复", () => {
    const a = makeItem("id-1");
    const b = makeItem("id-2");
    expect(buildContentKey(a)).toBe(buildContentKey(b));
  });

  it("同内容不同名视为不同文件（保留 P1-7 语义），不被去重", () => {
    const a = makeItem("id-1", { fileName: "a.bin" });
    const b = makeItem("id-2", { fileName: "b.bin" });
    expect(buildContentKey(a)).not.toBe(buildContentKey(b));
  });

  it("队列中已有不同文件时，新的不同文件正常入队", () => {
    const existing = [makeItem("prev", { fileName: "existing.bin" })];
    const incoming = [makeItem("new", { fileName: "incoming.bin" })];
    const { newItems, skipped } = dedupeByContentKey(existing, incoming);
    expect(newItems).toHaveLength(1);
    expect(newItems[0]?.id).toBe("new");
    expect(skipped).toBe(0);
  });

  it("已在队列中的同内容文件再次选择被跳过，只保留一条", () => {
    const existing = [makeItem("prev")];
    const incoming = [makeItem("dup")];
    const { newItems, skipped } = dedupeByContentKey(existing, incoming);
    expect(newItems).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("本批内重复选择同一文件只保留一条", () => {
    const existing: Array<ContentKeyed & { id: string }> = [];
    const incoming = [makeItem("x"), makeItem("y")];
    const { newItems, skipped } = dedupeByContentKey(existing, incoming);
    expect(newItems).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("队列已有同名同内容记录、本次又选一次 → 全部跳过且 skipped 计数正确", () => {
    const existing = [makeItem("already")];
    const incoming = [makeItem("dup1"), makeItem("dup2")];
    const { newItems, skipped } = dedupeByContentKey(existing, incoming);
    expect(newItems).toHaveLength(0);
    expect(skipped).toBe(2);
  });
});
