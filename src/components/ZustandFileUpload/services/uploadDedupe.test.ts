import { describe, expect, it } from "vitest";
import {
  buildContentKey,
  reconcileIncomingFiles,
  type ContentKeyed,
  type RebindableRecord,
} from "./uploadDedupe";
import { UploadStatus } from "../types/upload";

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

describe("buildContentKey（T-59 指纹无歧义）", () => {
  it("同内容不同 id 仍视为重复", () => {
    const a = makeItem("id-1");
    const b = makeItem("id-2");
    expect(buildContentKey(a)).toBe(buildContentKey(b));
  });

  it("同内容不同名视为不同文件（保留 P1-7 语义），不被去重", () => {
    const a = makeItem("id-1", { fileName: "a.bin" });
    const b = makeItem("id-2", { fileName: "b.bin" });
    expect(buildContentKey(a)).not.toBe(buildContentKey(b));
  });

  it("值含 | 时不会让两个不同元组拼成同一指纹（T-59 分隔符失真加固）", () => {
    // 旧实现用 | 拼接，元素/字段含 | 会串扰；现用 NUL 分隔，字段值含 | 也无歧义。
    const a = makeItem("id-a", { hash: "a|1", fileName: "2" });
    const b = makeItem("id-b", { hash: "a", fileName: "1|2" });
    expect(buildContentKey(a)).not.toBe(buildContentKey(b));
    // 含 | 的文件名不被拆断：同一 fileName（带 |）两次计算指纹一致
    const c = makeItem("id-c", { fileName: "image/png|alias" });
    const d = makeItem("id-d", { fileName: "image/png|alias" });
    expect(buildContentKey(c)).toBe(buildContentKey(d));
  });
});

describe("reconcileIncomingFiles（E2E-02 跨会话分片键稳定 + T-59）", () => {
  const makeRecord = (
    id: string,
    over: Partial<RebindableRecord> = {}
  ): RebindableRecord => ({
    id,
    hash: "h1",
    fileSize: 1024,
    lastModified: 1700000000000,
    fileName: "a.bin",
    status: UploadStatus.ERROR,
    chunkSize: 256 * 1024,
    chunkCount: 4,
    ...over,
  });

  it("刷新后残留的中断记录可被重新选择接管，复用原 id", () => {
    const existing = [makeRecord("q-old")];
    const incoming = [makeItem("q-new")];
    const { newItems, rebindItems, skipped } = reconcileIncomingFiles(
      existing,
      incoming
    );
    expect(newItems).toHaveLength(0);
    expect(rebindItems).toHaveLength(1);
    expect(rebindItems[0]?.existing.id).toBe("q-old");
    expect(rebindItems[0]?.incoming.id).toBe("q-new");
    expect(skipped).toBe(0);
  });

  it("已完成记录不被接管，仍按重复跳过", () => {
    const existing = [makeRecord("q-done", { status: UploadStatus.INSTANT })];
    const { rebindItems, skipped } = reconcileIncomingFiles(existing, [
      makeItem("q-new"),
    ]);
    expect(rebindItems).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("内存中仍持有 fileRef 的上传中记录不被接管", () => {
    const existing = [
      makeRecord("q-active", {
        status: UploadStatus.UPLOADING,
        fileRef: new File(["x"], "a.bin"),
      }),
    ];
    const { rebindItems, skipped } = reconcileIncomingFiles(existing, [
      makeItem("q-new"),
    ]);
    expect(rebindItems).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("没有同内容记录时按新文件入队", () => {
    const existing = [makeRecord("q-other", { fileName: "other.bin" })];
    const { newItems, rebindItems } = reconcileIncomingFiles(existing, [
      makeItem("q-new"),
    ]);
    expect(newItems.map((item) => item.id)).toEqual(["q-new"]);
    expect(rebindItems).toHaveLength(0);
  });

  it("队列中已有同内容文件再次选择被跳过，只保留一条", () => {
    const existing = [makeItem("prev")];
    const incoming = [makeItem("dup")];
    const { newItems, skipped } = reconcileIncomingFiles(existing, incoming);
    expect(newItems).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("本批内重复选择同一文件只保留一条", () => {
    const existing: Array<ContentKeyed & { id: string }> = [];
    const incoming = [makeItem("x"), makeItem("y")];
    const { newItems, skipped } = reconcileIncomingFiles(existing, incoming);
    expect(newItems).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("T-59：无 hash 的记录不参与内容去重（hash 空时不做内容去重）", () => {
    // 既有记录无 hash：即便 size/name/lm 与入队项相同，也不应被 rebind / 跳过。
    const existing = [
      makeRecord("q-nohash", { hash: "" }),
      makeRecord("q-nohash2", { hash: undefined }),
    ];
    const incoming = [makeItem("q-new")];
    const { newItems, rebindItems, skipped } = reconcileIncomingFiles(
      existing,
      incoming
    );
    expect(newItems).toHaveLength(1);
    expect(rebindItems).toHaveLength(0);
    expect(skipped).toBe(0);
  });
});
