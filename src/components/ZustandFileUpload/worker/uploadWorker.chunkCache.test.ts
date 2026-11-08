import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInstanceCache,
  deleteFileCache,
  putCachedChunks,
  readCachedChunk,
} from "../services/chunkCacheStore";

/**
 * Worker 分片缓存续传（方案 A）：fileRef 缺失时从 IndexedDB 读片；
 * 上传成功即删片；缓存缺片必须以 cacheMissing 上报（需重新选择文件）。
 */

const postedMessages: Array<{ type: string; [key: string]: unknown }> = [];
const uploadedChunkIndexes: number[] = [];

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let serverExistingChunks: number[] = [];

const fetchMock = vi.fn(async (url: string, options: RequestInit = {}) => {
  if (String(url).includes("/instant")) {
    return jsonResponse({ code: 200, data: { uploaded: false } });
  }
  if (String(url).includes("/status")) {
    return jsonResponse({
      code: 200,
      data: { chunks: serverExistingChunks },
    });
  }
  if (String(url).includes("/merge")) {
    return jsonResponse({ code: 200 });
  }
  const body = options.body as FormData;
  uploadedChunkIndexes.push(Number(body.get("index")));
  return jsonResponse({ code: 200 });
});

const dispatch = (data: unknown) => {
  const handler = (self as unknown as { onmessage: (e: MessageEvent) => void })
    .onmessage;
  return handler({ data } as MessageEvent);
};

const resetDatabase = async (): Promise<void> => {
  // 直接清空本实例数据，避免 Worker 重新 import 后残留连接阻塞 deleteDatabase。
  await deleteFileCache(cacheKey).catch(() => undefined);
  await clearInstanceCache(cacheKey.instanceId).catch(() => undefined);
};

const cacheKey = { instanceId: "worker-inst", fileId: "worker-file" };

const runUpload = (fileRef?: File) =>
  dispatch({
    type: "upload",
    fileInfo: {
      id: cacheKey.fileId,
      fileName: "worker.bin",
      fileSize: 8,
      hash: "2".repeat(32),
      chunkSize: 4,
      chunkKey: `${"2".repeat(32)}_8_4`,
    },
    ...(fileRef ? { fileRef } : {}),
    chunkCache: { instanceId: cacheKey.instanceId },
    networkParams: { chunkConcurrency: 1, maxRetries: 1 },
    uploadConfig: {
      baseURL: "",
      uploadApi: "/api/file/upload",
      checkApi: "/api/file/instant",
      mergeApi: "/api/file/merge",
    },
  });

describe("uploadWorker 分片缓存续传（方案 A）", () => {
  beforeEach(async () => {
    await resetDatabase();
    serverExistingChunks = [];
    uploadedChunkIndexes.length = 0;
    postedMessages.length = 0;
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    (self as unknown as { postMessage: unknown }).postMessage = (message: {
      type: string;
    }) => {
      postedMessages.push(message);
    };
    await import("./uploadWorker");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    await resetDatabase();
  });

  it("无 fileRef：从缓存读取全部分片完成上传，成功后清空缓存", async () => {
    await putCachedChunks(cacheKey, [
      { index: 0, data: new Uint8Array([1, 1, 1, 1]).buffer },
      { index: 1, data: new Uint8Array([2, 2, 2, 2]).buffer },
    ]);

    await runUpload();

    expect(uploadedChunkIndexes.sort()).toEqual([0, 1]);
    expect(postedMessages.some((m) => m.type === "done")).toBe(true);
    expect(postedMessages.some((m) => m.type === "error")).toBe(false);

    await vi.waitFor(async () => {
      expect(await readCachedChunk(cacheKey, 0)).toBeUndefined();
      expect(await readCachedChunk(cacheKey, 1)).toBeUndefined();
    });
  });

  it("无 fileRef 且缓存缺片：上报 cacheMissing，且不发送该分片", async () => {
    await putCachedChunks(cacheKey, [
      { index: 1, data: new Uint8Array([2, 2, 2, 2]).buffer },
    ]);

    await runUpload();

    expect(postedMessages.some((m) => m.type === "done")).toBe(false);
    const errorMessage = postedMessages.find((m) => m.type === "error");
    expect(errorMessage?.cacheMissing).toBe(true);
    expect(String(errorMessage?.message)).toContain("缓存缺失");
    expect(uploadedChunkIndexes).not.toContain(0);
  });

  it("服务端已存在的分片跳过上传并回收本地缓存，仅补齐缺失分片", async () => {
    serverExistingChunks = [0];
    await putCachedChunks(cacheKey, [
      { index: 0, data: new Uint8Array([1, 1, 1, 1]).buffer },
      { index: 1, data: new Uint8Array([2, 2, 2, 2]).buffer },
    ]);

    await runUpload();

    expect(uploadedChunkIndexes).toEqual([1]);
    expect(postedMessages.some((m) => m.type === "done")).toBe(true);

    await vi.waitFor(async () => {
      expect(await readCachedChunk(cacheKey, 0)).toBeUndefined();
      expect(await readCachedChunk(cacheKey, 1)).toBeUndefined();
    });
  });

  it("会话内 fileRef 优先于缓存：不读取也不依赖缓存", async () => {
    const fileRef = new File([new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])], "w.bin");

    await runUpload(fileRef);

    expect(uploadedChunkIndexes.sort()).toEqual([0, 1]);
    expect(postedMessages.some((m) => m.type === "done")).toBe(true);
  });
});
