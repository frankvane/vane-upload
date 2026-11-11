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
  getFileCacheMeta,
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

  it("T-54：固定上限按「待缓存分片字节」判断；已确认分片不落盘", async () => {
    const { file, fileRef } = createFixture("cache-pending", 10, 4);
    // 3 片里已确认 2 片 → 待缓存 1 片（2 字节）；文件总大小 10 字节
    file.uploadedChunks = 2;

    const status = await primeChunkCache(file, fileRef, {
      instanceId: "inst",
      maxFileSize: 5,
    });

    expect(status).toBe("ready");
    expect(await isFileCacheReady("inst", file.id)).toBe(true);

    const keys = { instanceId: "inst", fileId: file.id };
    // 已确认的 2 片不应再占缓存空间（旧实现从 index=0 写满整文件，此断言必红）
    expect(await readCachedChunk(keys, 0)).toBeUndefined();
    expect(await readCachedChunk(keys, 1)).toBeUndefined();
    // 仅未确认的第 3 片被缓存，且 meta 记录基准偏移
    expect(await readCachedChunk(keys, 2)).toBeDefined();
    expect((await getFileCacheMeta(keys))?.cachedFromIndex).toBe(2);
  });

  it("T-54：已传大部分时预检字节 ≡ 实际写入字节（紧配额不误放行越界）", async () => {
    const { file, fileRef } = createFixture("cache-quota-bound", 10, 4);
    file.uploadedChunks = 2; // 待缓存 2 字节
    // cacheable = (quota - usage) * 0.8 = (100 - 96) * 0.8 = 3.2；
    // pendingBytes=2 通过预检，整文件 10 不通过——旧实现会写满整文件越界。
    vi.stubGlobal("navigator", {
      storage: { estimate: async () => ({ quota: 100, usage: 96 }) },
    });

    const status = await primeChunkCache(file, fileRef, { instanceId: "inst" });

    expect(status).toBe("ready");
    const keys = { instanceId: "inst", fileId: file.id };
    // 实际只落盘待缓存的 1 片；已确认的 2 片不被写回
    expect(await readCachedChunk(keys, 0)).toBeUndefined();
    expect(await readCachedChunk(keys, 1)).toBeUndefined();
    expect(await readCachedChunk(keys, 2)).toBeDefined();
  });

  it("T-54：已确认分片覆盖全文件时跳过缓存（无可缓存内容，不写就绪标记）", async () => {
    const { file, fileRef } = createFixture("cache-done", 10, 4);
    file.uploadedChunks = 3; // 全部 3 片已确认

    const status = await primeChunkCache(file, fileRef, { instanceId: "inst" });

    expect(status).toBe("skipped");
    expect(await isFileCacheReady("inst", file.id)).toBe(false);
    expect(
      await getFileCacheMeta({ instanceId: "inst", fileId: file.id })
    ).toBeUndefined();
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

  /**
   * T-53：预热全量 put 与 Worker 逐片 delete 乱序的数据一致性缺陷。
   * 主线程预热写全部分片（fire-and-forget），上传 Worker 每确认一片即
   * `deleteCachedChunk`（chunkPipeline.ts:165）—— 若预热在上传清理之后写回分片，
   * 已确认分片会成为孤儿分片（index < uploadedChunks 仍残留）。
   * 修复：文件级 epoch，过期写回被 store 忽略。这里用 store 原语确定性复现该竞态，
   * 不依赖真实 Worker 时序——先写第 1 批，再模拟上传逐片确认（bump 代际），
   * 最后让预热写第 2 批，断言第 2 批被忽略、无孤儿分片。
   */
  it("T-53：预热与上传并行时，已确认分片不会被写回（文件级 epoch 拦截过期写）", async () => {
    const key = { instanceId: "inst", fileId: "race" };
    const chunkCount = 25; // >16 片，触发多批预热
    const makeBatch = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => ({
        index: from + i,
        data: new Uint8Array([(from + i) % 256]).buffer,
      }));

    // 模拟预热：先写第 1 批（generation=0，与文件当前 epoch 一致 → 落盘）
    expect(await putCachedChunks(key, makeBatch(0, 16), 0)).toBe(16);

    // 模拟上传：服务端逐片确认并释放本地缓存（chunkPipeline.ts:165 的真实路径），
    // 每确认一片即 bump 文件代际
    for (let index = 0; index < chunkCount; index += 1) {
      await deleteCachedChunk(key, index);
    }

    // 此时代际已被 bump 到 chunkCount；预热仍在后台写第 2 批（大文件未写完）。
    // 修复前：generation=0 不被拦截 → 16..24 写回成为孤儿分片；
    // 修复后：第 2 批被整体忽略（返回 0）。
    expect(await putCachedChunks(key, makeBatch(16, chunkCount), 0)).toBe(0);

    // 枚举 chunks store：所有分片（index < uploadedChunks=25）均不应残留
    let orphan = 0;
    for (let index = 0; index < chunkCount; index += 1) {
      if (await readCachedChunk(key, index)) orphan += 1;
    }
    expect(orphan).toBe(0);
  });

  /**
   * T-53（集成）：预热进行中被上传清理，过期批次被忽略且不写就绪标记。
   * 用可暂停的文件切片把预热卡在第 2 批之前，注入上传清理（bump 代际）后再放行，
   * 断言 runPrime 因过期写回被忽略而提前结束（不写 ready 标记）、无孤儿分片。
   */
  it("T-53（集成）：预热进行中被上传清理，过期批次被忽略且不写就绪标记", async () => {
    const { file, fileRef } = createFixture("cache-preempt", 100, 4); // 25 片
    const originalSlice = fileRef.slice.bind(fileRef);
    let stallResolve: (() => void) | null = null;
    let stalled = false;
    Object.defineProperty(fileRef, "slice", {
      value: (start = 0, end?: number) => {
        if (start >= 64 && !stalled) {
          // 第 2 批（索引 16+，start≥64）卡住，便于注入上传清理后再放行
          stalled = true;
          return {
            arrayBuffer: () =>
              new Promise<ArrayBuffer>((resolve) => {
                stallResolve = () => resolve(new Uint8Array([9]).buffer);
              }),
          } as unknown as Blob;
        }
        return originalSlice(start, end);
      },
    });

    const statusPromise = primeChunkCache(file, fileRef, { instanceId: "inst" });
    // 等首批 16 片落盘（chunk 0 已存在）再注入上传清理
    await vi.waitFor(async () => {
      expect(
        await readCachedChunk({ instanceId: "inst", fileId: file.id }, 0)
      ).toBeDefined();
    });

    // 模拟上传：逐片确认并释放本地缓存（bump 代际）
    for (let index = 0; index < 25; index += 1) {
      await deleteCachedChunk({ instanceId: "inst", fileId: file.id }, index);
    }

    // 放行第 2 批：此时代际已被 bump，过期写回应被忽略
    stallResolve?.();

    const status = await statusPromise;
    expect(status).toBe("unavailable");

    // 关键：不写就绪标记，且第 2 批未写回任何分片（无孤儿分片）
    expect(await isFileCacheReady("inst", file.id)).toBe(false);
    let orphan = 0;
    for (let index = 0; index < 25; index += 1) {
      if (await readCachedChunk({ instanceId: "inst", fileId: file.id }, index)) {
        orphan += 1;
      }
    }
    expect(orphan).toBe(0);
  });
});
