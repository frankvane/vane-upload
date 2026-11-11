import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UploadStatus, type UploadFile } from "../types/upload";
import {
  isFileCacheReady,
  primeChunkCache,
  __test_primeEntryCount,
} from "./chunkCache";
import {
  CHUNK_CACHE_DB_NAME,
  clearInstanceCache,
  closeChunkCacheDb,
  getFileCacheMeta,
  listReadyFileIds,
  putCachedChunks,
  readCachedChunk,
  readGeneration,
} from "./chunkCacheStore";

/**
 * T-73 ⑤-B：IndexedDB 故障注入与并发表驱动。
 *
 * 判据要求「每条都有可失败的断言」，因此全部使用精确值（具体 reject 文案、
 * 具体集合内容、具体计数），不使用 toBeGreaterThan(0) / not.toThrow 式判定。
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
  size = 12,
  chunkSize = 4,
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
    schemaVersion: 2,
    hash: "fixture-hash",
  };
  return { file, fileRef, bytes };
};

const key = (fileId: string) => ({ instanceId: "inst", fileId });

describe("T-73 分片缓存故障注入（精确断言）", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await resetDatabase();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase();
  });

  describe("IDB 事务级中止（onabort / onerror）", () => {
    /**
     * 关键：IDB 规范里事务 abort 时未完成的 request 可能既不触发 onsuccess
     * 也不触发 onerror。这里返回一个「永不 settle 的假 request」，只让事务
     * abort，从而精确验证新增的事务级监听确实必要——若删掉 bindTxFailure，
     * Promise 会永久挂起（测试超时转红），而不是靠 request.onerror 兜底。
     */
    const stubSilentRequest = (
      proto: IDBObjectStore,
      method: "get" | "openCursor",
      options: { abort?: boolean; txError?: Error } = {},
    ) => {
      const { abort = true, txError } = options;
      const original = proto[method] as (
        this: IDBObjectStore,
        ...args: unknown[]
      ) => IDBRequest;
      return vi
        .spyOn(proto, method)
        .mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
          const real = original.apply(this, args as never);
          const tx = real.transaction;
          if (!tx) {
            throw new Error("测试注入失败：request 没有关联事务");
          }
          // 真实 request 仍被创建（保持事务活跃），但对外返回不派发事件的壳
          const silent = {
            transaction: tx,
            result: undefined,
            error: null,
          } as unknown as IDBRequest;
          if (txError) {
            // 模拟「请求失败导致的事务中止」：此时浏览器会在事务上留下
            // 明确的 tx.error，bindTxFailure 的 error 通道必须原样透传它。
            Object.defineProperty(tx, "error", {
              configurable: true,
              value: txError,
            });
          }
          if (abort) {
            queueMicrotask(() => {
              try {
                tx.abort();
              } catch {
                // 事务已结束则忽略
              }
            });
          }
          return silent;
        });
    };

    it("只读事务中止且 request 不派发事件时，readCachedChunk 以事务中止错误 reject", async () => {
      const spy = stubSilentRequest(IDBObjectStore.prototype, "get");

      await expect(readCachedChunk(key("abort-read"), 0)).rejects.toMatchObject({
        name: "Error",
        message: "读取分片缓存失败（事务已中止）",
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("事务级 error 通道在 tx.error 已赋值时原样透传该错误（onerror 分支）", async () => {
      const failure = new Error("模拟事务级 error");
      failure.name = "InjectedTransactionError";
      const spy = stubSilentRequest(IDBObjectStore.prototype, "get", {
        txError: failure,
      });

      // 精确断言是「同一个错误对象」而非包装后的泛化 Error：
      // 若 error 通道被删掉或被 fallback 抢先结算，这里立即转红。
      await expect(readCachedChunk(key("tx-error"), 0)).rejects.toBe(failure);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("readGeneration / getFileCacheMeta 在同样的静默中止下也 reject（不挂起）", async () => {
      const spy = stubSilentRequest(IDBObjectStore.prototype, "get");

      await expect(readGeneration(key("abort-gen"))).rejects.toMatchObject({
        name: "Error",
        message: "读取代际失败（事务已中止）",
      });
      await expect(getFileCacheMeta(key("abort-meta"))).rejects.toMatchObject({
        name: "Error",
        message: "读取分片缓存元数据失败（事务已中止）",
      });
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("游标遍历中途事务中止时 listReadyFileIds reject，不返回半成品集合", async () => {
      const { file, fileRef } = createFixture("cursor-ready", 8, 4);
      expect(
        await primeChunkCache(file, fileRef, { instanceId: "inst" })
      ).toBe("ready");

      stubSilentRequest(IDBObjectStore.prototype, "openCursor");

      await expect(listReadyFileIds("inst")).rejects.toMatchObject({
        name: "Error",
        message: "列举分片缓存失败（事务已中止）",
      });
    });

    it("写入事务 abort 时 putCachedChunks 以「分片缓存事务失败」reject 且不留分片", async () => {
      const chunks = [{ index: 0, data: new Uint8Array([1, 2, 3]).buffer }];
      const originalPut = IDBObjectStore.prototype.put;
      vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
        this: IDBObjectStore,
        ...args
      ) {
        const request = originalPut.apply(this, args as never);
        queueMicrotask(() => {
          try {
            request.transaction?.abort();
          } catch {
            // noop
          }
        });
        return request;
      });

      await expect(putCachedChunks(key("abort-write"), chunks)).rejects.toThrow(
        "分片缓存事务失败",
      );
      vi.restoreAllMocks();
      expect(await readCachedChunk(key("abort-write"), 0)).toBeUndefined();
    });

    it("游标删除失败时中止整个事务：清理 reject 且缓存整体回滚（不静默少删）", async () => {
      const { file, fileRef } = createFixture("cursor-delete", 8, 4);
      expect(
        await primeChunkCache(file, fileRef, { instanceId: "inst" })
      ).toBe("ready");

      const originalCursor = IDBObjectStore.prototype.openKeyCursor;
      const spy = vi
        .spyOn(IDBObjectStore.prototype, "openKeyCursor")
        .mockImplementation(function (
          this: IDBObjectStore,
          ...args: unknown[]
        ) {
          const real = originalCursor.apply(this, args as never);
          if (this.name !== "chunks") {
            return real;
          }
          // 只给 chunks 游标一个「永不成功、稍后报错」的壳，精确命中
          // deleteRange 的 request.onerror → transaction.abort() 分支。
          const fake = {
            transaction: real.transaction,
            result: null,
            error: null,
          } as unknown as IDBRequest;
          queueMicrotask(() => {
            (
              fake as unknown as { onerror: ((e: unknown) => void) | null }
            ).onerror?.(new Event("error"));
          });
          return fake;
        });

      await expect(clearInstanceCache("inst")).rejects.toThrow(
        "分片缓存事务失败",
      );
      expect(spy).toHaveBeenCalledTimes(3);
      vi.restoreAllMocks();

      // 事务整体回滚：就绪标记、就绪集合与分片都还在，不能「删一半却报成功」。
      expect(await isFileCacheReady("inst", "cursor-delete")).toBe(true);
      expect(await listReadyFileIds("inst")).toEqual(
        new Set(["cursor-delete"])
      );
      expect(await readCachedChunk(key("cursor-delete"), 0)).toBeDefined();
    });
  });

  describe("配额中途耗尽（QuotaExceededError）", () => {
    it("estimate 报充足但第 2 批 put 抛 QuotaExceededError → unavailable 且无 ready 标记、无残留分片", async () => {
      const { file, fileRef } = createFixture("quota-mid", 40, 4);
      vi.stubGlobal("navigator", {
        storage: { estimate: async () => ({ quota: 1_000_000, usage: 0 }) },
      });

      const originalPut = IDBObjectStore.prototype.put;
      let chunkPuts = 0;
      vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
        this: IDBObjectStore,
        ...args
      ) {
        if (this.name === "chunks") {
          chunkPuts += 1;
          if (chunkPuts === 3) {
            const error = new Error("QuotaExceededError");
            error.name = "QuotaExceededError";
            throw error;
          }
        }
        return originalPut.apply(this, args as never);
      });

      const status = await primeChunkCache(file, fileRef, {
        instanceId: "inst",
      });

      expect(status).toBe("unavailable");
      expect(chunkPuts).toBe(3);
      vi.restoreAllMocks();
      expect(await getFileCacheMeta(key("quota-mid"))).toBeUndefined();
      expect(await isFileCacheReady("inst", "quota-mid")).toBe(false);
      expect(await listReadyFileIds("inst")).toEqual(new Set());
      expect(await readCachedChunk(key("quota-mid"), 0)).toBeUndefined();
      expect(__test_primeEntryCount()).toBe(0);
    });

    it("首批 put 即失败时同样降级，且不写就绪标记", async () => {
      const { file, fileRef } = createFixture("quota-first", 8, 4);
      const originalPut = IDBObjectStore.prototype.put;
      vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
        this: IDBObjectStore,
        ...args
      ) {
        if (this.name === "chunks") {
          const error = new Error("QuotaExceededError");
          error.name = "QuotaExceededError";
          throw error;
        }
        return originalPut.apply(this, args as never);
      });

      expect(
        await primeChunkCache(file, fileRef, { instanceId: "inst" })
      ).toBe("unavailable");
      vi.restoreAllMocks();
      expect(await getFileCacheMeta(key("quota-first"))).toBeUndefined();
    });
  });

  describe("并发预热", () => {
    it("4 个文件并发预热：全部 ready、就绪集合恰好 4 个、entry 全部释放", async () => {
      const fixtures = ["c1", "c2", "c3", "c4"].map((id) =>
        createFixture(id, 12, 4)
      );

      const statuses = await Promise.all(
        fixtures.map(({ file, fileRef }) =>
          primeChunkCache(file, fileRef, { instanceId: "inst" })
        )
      );

      expect(statuses).toEqual(["ready", "ready", "ready", "ready"]);
      expect(await listReadyFileIds("inst")).toEqual(
        new Set(["c1", "c2", "c3", "c4"])
      );
      expect(__test_primeEntryCount()).toBe(0);
      for (const id of ["c1", "c2", "c3", "c4"]) {
        expect(await isFileCacheReady("inst", id)).toBe(true);
      }
    });

    it("同一文件并发预热只落盘一次，返回同一个 ready 结论", async () => {
      const { file, fileRef } = createFixture("dedupe", 12, 4);
      const [a, b] = await Promise.all([
        primeChunkCache(file, fileRef, { instanceId: "inst" }),
        primeChunkCache(file, fileRef, { instanceId: "inst" }),
      ]);
      expect(a).toBe("ready");
      expect(b).toBe("ready");
      expect(await listReadyFileIds("inst")).toEqual(new Set(["dedupe"]));
      expect(__test_primeEntryCount()).toBe(0);
    });

    it("其它标签页升级 schema 时本连接让出、升级不被 blocked；本模块以 VersionError 明确降级且不挂起", async () => {
      const { file, fileRef } = createFixture("version-change", 8, 4);
      expect(
        await primeChunkCache(file, fileRef, { instanceId: "inst" })
      ).toBe("ready");
      expect(await isFileCacheReady("inst", "version-change")).toBe(true);

      const closeSpy = vi.spyOn(IDBDatabase.prototype, "close");
      let blockedCount = 0;
      let upgradedVersion = 0;
      // 另一标签页以更高版本打开同一数据库：触发本连接的 onversionchange，
      // 生产侧 db.close() + dbPromise=null 应让升级不被 blocked。
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(CHUNK_CACHE_DB_NAME, 3);
        request.onupgradeneeded = () => {
          /* 升级事务本身即代表另一标签页接管 */
        };
        request.onsuccess = () => {
          upgradedVersion = request.result.version;
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
          blockedCount += 1;
          reject(new Error("升级被阻塞"));
        };
      });

      // 精确 2 次：本连接让出 1 次 + 测试关闭 v3 连接 1 次
      expect(closeSpy).toHaveBeenCalledTimes(2);
      expect(blockedCount).toBe(0);
      expect(upgradedVersion).toBe(3);
      vi.restoreAllMocks();

      // 本模块固定以 v2 打开，v3 库会触发 VersionError：契约是「不挂起、
      // 不抛未处理异常」，就绪判定明确降级为 false、列举以精确错误 reject。
      expect(await isFileCacheReady("inst", "version-change")).toBe(false);
      await expect(listReadyFileIds("inst")).rejects.toMatchObject({
        name: "VersionError",
      });

      // dbPromise 已释放：删库重建后可再次正常预热，不会被旧连接永久毒化。
      await resetDatabase();
      const again = createFixture("version-change", 8, 4);
      expect(
        await primeChunkCache(again.file, again.fileRef, { instanceId: "inst" })
      ).toBe("ready");
      expect(await isFileCacheReady("inst", "version-change")).toBe(true);
    });
  });
});
