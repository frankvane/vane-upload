import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadStatus } from "../types/upload";
import { HASH_CONCURRENCY, prepareFiles } from "./filePrepareWorker";

const makeFile = (name: string, size = 16) =>
  new File([new Uint8Array(size).fill(7)], name, {
    type: "application/octet-stream",
  });

const yieldTwice = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("filePrepareWorker.prepareFiles（VU-43 哈希并发池）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("多个文件哈希并发执行，结果按选择顺序归并", async () => {
    const files = Array.from({ length: 6 }, (_, i) => makeFile(`f${i}.bin`));
    let active = 0;
    let peak = 0;

    const hashFile = vi.fn(async (file: File) => {
      active += 1;
      peak = Math.max(peak, active);
      await yieldTwice();
      active -= 1;
      return `hash-${file.name}`;
    });

    const { uploadFiles, stats } = await prepareFiles(files, { hashFile });

    expect(peak).toBe(HASH_CONCURRENCY);
    expect(hashFile).toHaveBeenCalledTimes(6);
    expect(uploadFiles.map((file) => file.order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(uploadFiles.map((file) => file.fileName)).toEqual(
      files.map((file) => file.name),
    );
    expect(uploadFiles.every((file) => file.status === UploadStatus.QUEUED)).toBe(
      true,
    );
    expect(stats).toEqual({
      processed: 6,
      total: 6,
      success: 6,
      failed: 0,
      oversized: 0,
    });
  });

  it("单个文件哈希失败只影响该文件，其余继续并发出错误进度", async () => {
    // 失败路径会经 debugError 打日志，这里静音以免污染测试输出
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const files = [makeFile("ok1.bin"), makeFile("bad.bin"), makeFile("ok2.bin")];
    const progress: Array<Record<string, unknown>> = [];

    const { uploadFiles, stats } = await prepareFiles(files, {
      hashFile: async (file) => {
        if (file.name === "bad.bin") throw new Error("read failed");
        return `hash-${file.name}`;
      },
      onProgress: (payload) => {
        progress.push(payload as unknown as Record<string, unknown>);
      },
    });

    expect(uploadFiles.map((file) => file.fileName)).toEqual([
      "ok1.bin",
      "ok2.bin",
    ]);
    // 并发归并后仍按原 index 排布，跳过失败项不会错序
    expect(uploadFiles.map((file) => file.order)).toEqual([0, 2]);
    expect(stats).toMatchObject({ total: 3, success: 2, failed: 1 });
    const errorProgress = progress.find(
      (payload) =>
        (payload.fileDetails as { error?: boolean } | undefined)?.error === true,
    );
    expect(errorProgress).toBeDefined();
    expect(
      (errorProgress?.fileDetails as { errorMessage?: string })?.errorMessage,
    ).toContain("read failed");
  });

  it("0 字节文件不发起任何分片，chunkCount 为 0", async () => {
    const { uploadFiles } = await prepareFiles([makeFile("empty.bin", 0)], {
      hashFile: async () => "a".repeat(32),
    });
    expect(uploadFiles).toHaveLength(1);
    expect(uploadFiles[0]?.chunkCount).toBe(0);
  });

  it("真实流式哈希可跑通（jsdom Blob.arrayBuffer 兼容）", async () => {
    const { uploadFiles, stats } = await prepareFiles(
      [makeFile("real.bin", 2048)],
      { chunkSize: 512 },
    );
    expect(stats.success).toBe(1);
    expect(uploadFiles[0]?.hash).toMatch(/^[a-f0-9]{32}$/);
    expect(uploadFiles[0]?.chunkCount).toBe(4);
  });
});
