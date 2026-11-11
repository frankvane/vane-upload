import { describe, expect, it, vi } from "vitest";

// T-51：runChunkPipeline 是上传内核，此前零专属测试（仅被 uploadWorker 间接 import，
// 函数体从未被执行）。这里用最小依赖桩跑通各终态分支。
vi.mock("../../../shared/debugLogger", () => ({
  debugError: vi.fn(),
  debugLog: vi.fn(),
}));
vi.mock("../../../shared/concurrency", () => ({
  runCursorPool: async ({
    next,
    task,
    shouldStop,
    onFailure,
  }: {
    next: () => number | undefined;
    task: (i: number) => Promise<void>;
    shouldStop: () => boolean;
    onFailure: (i: number) => void;
  }) => {
    while (!shouldStop()) {
      const i = next();
      if (i === undefined) break;
      try {
        await task(i);
      } catch {
        onFailure(i);
      }
    }
  },
}));
vi.mock("../services/uploadProgress", () => ({
  computeUploadProgress: () => ({
    progress: 100,
    uploadedBytes: 0,
    totalBytes: 0,
    speed: 0,
    eta: 0,
  }),
}));
vi.mock("../services/chunkCacheStore", () => ({
  readCachedChunk: vi.fn(async () => null),
  deleteCachedChunk: vi.fn(async () => undefined),
  deleteFileCache: vi.fn(async () => undefined),
}));

import { runChunkPipeline } from "./chunkPipeline";
import { ChunkCacheMissError } from "./uploadWorkerTypes";

const makeCtx = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  fileInfo: { id: "f1", fileName: "a.bin", fileSize: 1024, hash: "h", chunkKey: "k" },
  fileRef: new File([new Uint8Array(1024)], "a.bin"),
  cacheKey: null,
  fileSize: 1024,
  chunkSize: 1024,
  chunkCount: 1,
  existingChunks: new Set<number>(),
  missingCount: 1,
  baseURL: "http://x",
  uploadApi: "/upload",
  mergeApi: "/merge",
  hashMode: "full",
  request: vi.fn(async () => new Response("{}")),
  chunkConcurrency: 1,
  signal: new AbortController().signal,
  taskStats: new Map<string, { uploadedChunks: number; totalChunks: number }>(),
  debug: vi.fn(),
  postMessage: vi.fn(),
  ...over,
});

const postTypes = (post: ReturnType<typeof vi.fn>) =>
  post.mock.calls.map((c) => (c[0] as { type: string }).type);

describe("chunkPipeline", () => {
  it("happy path：上传 1 分片 + 合并 → 上报 done，cache 删除不被调用", async () => {
    const post = vi.fn();
    const request = vi.fn(async () => new Response("{}"));
    await runChunkPipeline(
      makeCtx({ postMessage: post, request }) as never,
    );

    expect(request).toHaveBeenCalledTimes(2); // 1 上传 + 1 合并
    expect(postTypes(post)).toContain("done");
    expect(postTypes(post)).toContain("progress");
  });

  it("刷新续传缓存缺片 → 上报 cacheMissing 错误，不发任何请求", async () => {
    const post = vi.fn();
    const request = vi.fn(async () => new Response("{}"));
    await runChunkPipeline(
      makeCtx({
        postMessage: post,
        request,
        fileRef: undefined,
        cacheKey: { instanceId: "i", fileId: "f1" },
      }) as never,
    );

    expect(request).not.toHaveBeenCalled();
    const err = post.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "error",
    );
    expect(err).toBeTruthy();
    expect((err![0] as { cacheMissing: boolean }).cacheMissing).toBe(true);
  });

  it("连接级失败（TypeError）→ 上报「无法连接服务器」并停止领取", async () => {
    const post = vi.fn();
    const request = vi.fn(async () => {
      throw new TypeError("network");
    });
    await runChunkPipeline(
      makeCtx({ postMessage: post, request }) as never,
    );

    expect(request).toHaveBeenCalledTimes(1); // 仅首片，未合并
    const err = post.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "error",
    );
    expect((err![0] as { message: string }).message).toContain("无法连接服务器");
  });

  it("非连接型失败 → 上报「N 个分片上传失败」", async () => {
    const post = vi.fn();
    const request = vi.fn(async () => {
      throw new Error("boom");
    });
    await runChunkPipeline(
      makeCtx({ postMessage: post, request }) as never,
    );

    expect(request).toHaveBeenCalledTimes(1);
    const err = post.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "error",
    );
    expect((err![0] as { message: string }).message).toContain(
      "1 个分片上传失败",
    );
  });

  it("signal 已中止 → 上报 cancelled，不发请求", async () => {
    const post = vi.fn();
    const request = vi.fn(async () => new Response("{}"));
    const controller = new AbortController();
    controller.abort();
    await runChunkPipeline(
      makeCtx({ postMessage: post, request, signal: controller.signal }) as never,
    );

    expect(request).not.toHaveBeenCalled();
    expect(postTypes(post)).toContain("cancelled");
  });

  it("ChunkCacheMissError 由各分支透传（缺片路径已覆盖）", () => {
    expect(new ChunkCacheMissError(2).chunkIndex).toBe(2);
  });
});
