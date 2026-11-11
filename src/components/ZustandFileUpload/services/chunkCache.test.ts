import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadStatus, type UploadFile } from "../types/upload";
import {
  clearFileChunkCache,
  DEFAULT_CHUNK_CACHE_MAX_FILE_SIZE,
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

  it("默认不设固定上限（Infinity），上限为 0 也视为不限制", async () => {
    expect(DEFAULT_CHUNK_CACHE_MAX_FILE_SIZE).toBe(
      Number.POSITIVE_INFINITY
    );

    const { file, fileRef } = createFixture("cache-unlimited", 10, 4);
    const status = await primeChunkCache(file, fileRef, {
      instanceId: "inst",
      maxFileSize: 0,
    });

    expect(status).toBe("ready");
    expect(await isFileCacheReady("inst", file.id)).toBe(true);
  });

  it("固定上限按「待缓存分片字节」判断，而非整个文件大小", async () => {
    const { file, fileRef } = createFixture("cache-pending", 10, 4);
    // 3 片里已确认 2 片 → 待缓存 2 字节；文件总大小 10 字节
    file.uploadedChunks = 2;

    const status = await primeChunkCache(file, fileRef, {
      instanceId: "inst",
      maxFileSize: 5,
    });

    expect(status).toBe("ready");
    expect(await isFileCacheReady("inst", file.id)).toBe(true);
  });

  it("按可用空间的 80% 预检：够则缓存，不足降级为 insufficient-space", async () => {
    const enough = createFixture("cache-space-ok", 10, 4);
    vi.stubGlobal("navigator", {
      storage: {
        estimate: async () => ({ quota: 100, usage: 20 }),
      },
    });
    expect(
      await primeChunkCache(enough.file, enough.fileRef, {
        instanceId: "inst",
      })
    ).toBe("ready");

    const tight = createFixture("cache-space-tight", 10, 4);
    vi.stubGlobal("navigator", {
      storage: {
        estimate: async () => ({ quota: 100, usage: 90 }),
      },
    });
    expect(
      await primeChunkCache(tight.file, tight.fileRef, {
        instanceId: "inst",
      })
    ).toBe("insufficient-space");
    expect(await isFileCacheReady("inst", tight.file.id)).toBe(false);
  });

  it("成功预热时尝试申请持久化存储，失败不影响就绪", async () => {
    const { file, fileRef } = createFixture("cache-persist", 10, 4);
    const persist = vi.fn(async () => false);
    vi.stubGlobal("navigator", {
      storage: {
        estimate: async () => ({ quota: 1_000_000, usage: 0 }),
        persist,
      },
    });

    const status = await primeChunkCache(file, fileRef, {
      instanceId: "inst",
    });

    expect(status).toBe("ready");
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
  });

  it("存储配额不足时降级为 insufficient-space，且不留下半成品", async () => {
    const { file, fileRef } = createFixture("cache-quota", 10, 4);
    vi.stubGlobal("navigator", {
      storage: {
        estimate: async () => ({ quota: 1000, usage: 999 }),
      },
    });

    const status = await primeChunkCache(file, fileRef, {
      instanceId: "inst",
    });

    expect(status).toBe("insufficient-space");
    expect(await isFileCacheReady("inst", file.id)).toBe(false);
  });

  /**
   * T-05 把「就绪标记最后写入」抬成了唯一的安全依据：上传不再等预热完成，
   * 因此必须锁死「预热中途失败 → 不留就绪标记 → 半成品被回收」。
   */
  it("预热中途读文件失败：不写就绪标记，且已写入的分片被回收（不会读到半套缓存）", async () => {
    const { file, fileRef } = createFixture("cache-midfail", 80, 4);
    const originalSlice = fileRef.slice.bind(fileRef);
    let reads = 0;
    Object.defineProperty(fileRef, "slice", {
      value: (start = 0, end?: number) => {
        reads += 1;
        // 第一批 16 片（偏移 0..63）正常写入，第 17 片开始读失败
        if (start >= 64) {
          throw new Error("read failed");
        }
        return originalSlice(start, end);
      },
    });

    const status = await primeChunkCache(file, fileRef, { instanceId: "inst" });

    expect(status).toBe("unavailable");
    expect(reads).toBeGreaterThan(16);
    // 关键：没有就绪标记 → 续传判定降级重选，不会拿着半套分片去合并
    expect(await isFileCacheReady("inst", file.id)).toBe(false);
    expect(await listReadyFileIds("inst")).toEqual(new Set());
    expect(
      await readCachedChunk({ instanceId: "inst", fileId: file.id }, 0)
    ).toBeUndefined();
  });

  it("实例隔离：不同 instanceId 的缓存互不可见、互不误删", async () => {
    const { file, fileRef } = createFixture("cache-iso", 10, 4);

    await primeChunkCache(file, fileRef, { instanceId: "inst-a" });
    expect(await listReadyFileIds("inst-b")).toEqual(new Set());

    await clearFileChunkCache("inst-b", file.id);
    expect(await isFileCacheReady("inst-a", file.id)).toBe(true);
  });

  /**
   * T-52：就绪标记必须与「分片齐全」严格等价。
   * 已预热（ready）的文件在上传期每确认一分片即 deleteCachedChunk（chunkPipeline.ts:165），
   * 若删片不删 ready meta，则 listReadyFileIds 仍含该文件 —— 上传中途刷新会被误判为
   * 可零点击续传，实则缺片，续传在缺失分片处被 ChunkCacheMissError 二次降级（数据一致性缺陷）。
   * 修复前该断言红（listReadyFileIds 仍含 fileId），修复后绿（删片同时移除 ready meta）。
   */
  it("T-52：已就绪缓存删除单片后不再判为可续传（ready ≡ 分片齐全）", async () => {
    const { file, fileRef } = createFixture("cache-ready-del", 10, 4);

    const status = await primeChunkCache(file, fileRef, { instanceId: "inst" });
    expect(status).toBe("ready");
    expect(await listReadyFileIds("inst")).toEqual(new Set([file.id]));

    // 模拟服务端确认成功、释放本地单片缓存（chunkPipeline.ts:165 的真实调用路径）
    await deleteCachedChunk({ instanceId: "inst", fileId: file.id }, 0);

    // 关键不变量：删掉任一分片后，缓存不再完整，必须移出就绪集合。
    // （注：同一会话内 isFileCacheReady 仍可能命中内存 primeEntries 的 ready 快照，
    //  属 T-55 的内存 entry 释放范畴；真实刷新场景页面重载后内存快照消失、改读 IDB，
    //  此时 meta 已随删片移除 → 正确判非就绪。此处仅校验 T-52 的 IDB 级不变量。）
    expect(await listReadyFileIds("inst")).toEqual(new Set());
    // 该片已被清，其余分片仍在（不影响删除语义本身）
    expect(
      await readCachedChunk({ instanceId: "inst", fileId: file.id }, 0)
    ).toBeUndefined();
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
