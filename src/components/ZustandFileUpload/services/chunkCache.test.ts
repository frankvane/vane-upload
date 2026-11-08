import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadStatus, type UploadFile } from "../types/upload";
import {
  clearFileChunkCache,
  isFileCacheReady,
  primeChunkCache,
} from "./chunkCache";
import {
  CHUNK_CACHE_DB_NAME,
  closeChunkCacheDb,
  deleteCachedChunk,
  listReadyFileIds,
  putCachedChunks,
  readCachedChunk,
} from "./chunkCacheStore";

/**
 * 方案 A 分片缓存：验证“就绪提交标记 / 按文件清理 / 实例隔离 / 上限与配额降级”。
 * 使用 fake-indexeddb（src/test/setup.ts 已全局注入）。
 */

const resetDatabase = async (): Promise<void> => {
  await closeChunkCacheDb();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(CHUNK_CACHE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
};

const createFixture = (
  id: string,
  size = 10,
  chunkSize = 4
): { file: UploadFile; fileRef: File; bytes: Uint8Array } => {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = index + 1;
  }
  const fileRef = new File([bytes.buffer as ArrayBuffer], `${id}.bin`, {
    lastModified: 1700000000000,
  });
  const file: UploadFile = {
    id,
    fileName: `${id}.bin`,
    fileSize: size,
    fileType: "application/octet-stream",
    lastModified: 1700000000000,
    status: UploadStatus.QUEUED,
    progress: 0,
    chunkSize,
    chunkCount: Math.ceil(size / chunkSize),
    uploadedChunks: 0,
    createdAt: 1700000000000,
    order: 0,
    schemaVersion: 1,
    hash: "fixture-hash",
  };
  return { file, fileRef, bytes };
};

describe("chunkCache（方案 A）", () => {
  beforeEach(async () => {
    // 先恢复全局（IDB 不可用用例会 stub indexedDB），否则清理阶段无法 deleteDatabase
    vi.unstubAllGlobals();
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
  });

  it("预热后写入就绪标记，可读回全部分片；清理后不再可续传", async () => {
    const { file, fileRef, bytes } = createFixture("cache-a", 10, 4);

    const status = await primeChunkCache(file, fileRef, {
      instanceId: "inst",
    });

    expect(status).toBe("ready");
    expect(await isFileCacheReady("inst", file.id)).toBe(true);
    expect(await listReadyFileIds("inst")).toEqual(new Set([file.id]));

    const first = await readCachedChunk(
      { instanceId: "inst", fileId: file.id },
      0
    );
    expect(new Uint8Array(first!)).toEqual(bytes.slice(0, 4));

    await clearFileChunkCache("inst", file.id);

    expect(await isFileCacheReady("inst", file.id)).toBe(false);
    expect(await listReadyFileIds("inst")).toEqual(new Set());
    expect(
      await readCachedChunk({ instanceId: "inst", fileId: file.id }, 0)
    ).toBeUndefined();
  });

  it("超过单文件上限不缓存（skipped），不产生就绪标记", async () => {
    const { file, fileRef } = createFixture("cache-big", 10, 4);

    const status = await primeChunkCache(file, fileRef, {
      instanceId: "inst",
      maxFileSize: 5,
    });

    expect(status).toBe("skipped");
    expect(await isFileCacheReady("inst", file.id)).toBe(false);
    expect(await listReadyFileIds("inst")).toEqual(new Set());
  });

  it("IndexedDB 不可用时降级为 unavailable", async () => {
    const { file, fileRef } = createFixture("cache-noidb", 10, 4);
    vi.stubGlobal("indexedDB", undefined);

    const status = await primeChunkCache(file, fileRef, {
      instanceId: "inst",
    });

    expect(status).toBe("unavailable");
  });

  it("存储配额不足时降级为 unavailable，且不留下半成品", async () => {
    const { file, fileRef } = createFixture("cache-quota", 10, 4);
    vi.stubGlobal("navigator", {
      storage: {
        estimate: async () => ({ quota: 1000, usage: 999 }),
      },
    });

    const status = await primeChunkCache(file, fileRef, {
      instanceId: "inst",
    });

    expect(status).toBe("unavailable");
    expect(await isFileCacheReady("inst", file.id)).toBe(false);
  });

  it("实例隔离：不同 instanceId 的缓存互不可见、互不误删", async () => {
    const { file, fileRef } = createFixture("cache-iso", 10, 4);

    await primeChunkCache(file, fileRef, { instanceId: "inst-a" });
    expect(await listReadyFileIds("inst-b")).toEqual(new Set());

    await clearFileChunkCache("inst-b", file.id);
    expect(await isFileCacheReady("inst-a", file.id)).toBe(true);
  });

  it("store 层：删除单片后重新读取为空，其余分片不受影响", async () => {
    const key = { instanceId: "inst", fileId: "manual" };
    await putCachedChunks(key, [
      { index: 0, data: new Uint8Array([1, 2]).buffer },
      { index: 1, data: new Uint8Array([3, 4]).buffer },
    ]);

    await deleteCachedChunk(key, 0);

    expect(await readCachedChunk(key, 0)).toBeUndefined();
    expect(new Uint8Array((await readCachedChunk(key, 1))!)).toEqual(
      new Uint8Array([3, 4])
    );
  });
});
