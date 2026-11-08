import { beforeEach, describe, expect, it, vi } from "vitest";
import { UploadStatus, type UploadFile } from "../types/upload";
import { UPLOAD_SCHEMA_VERSION } from "./uploadSchema";

type IterateCallback = (value: unknown, key: string) => void;

const iterateMock = vi.fn<(callback: IterateCallback) => Promise<void>>();
const removeItemMock = vi.fn<(key: string) => Promise<void>>();
const setItemMock = vi.fn<(key: string, value: UploadFile) => Promise<void>>();

vi.mock("localforage", () => ({
  default: {
    iterate: (callback: IterateCallback) => iterateMock(callback),
    removeItem: (key: string) => removeItemMock(key),
    setItem: (key: string, value: UploadFile) => setItemMock(key, value),
  },
}));

const {
  isUploadableStatus,
  listUploadFiles,
  removeUploadFilesByIds,
  recoverInterruptedUploadFiles,
  recoverUploadQueueOnMount,
} = await import("./uploadStorage");

// T3.2：uploadStorage 服务改为接收显式 storage / fileRegistry 参数，
// 不再依赖 localforage 默认实例。这里用一个最小桩把 mock 桥接到 storage 接口。
const fakeStorage = {
  iterate: (callback: (value: unknown, key: string) => void) =>
    iterateMock(callback),
  removeItem: (key: string) => removeItemMock(key),
  setItem: (key: string, value: UploadFile) => setItemMock(key, value),
} as unknown as LocalForage;

const fakeRegistry = {
  registerFileRef: vi.fn(),
  getFileRef: vi.fn(),
  releaseFileRef: vi.fn(),
  releaseAllFileRefs: vi.fn(),
  fileRefCount: vi.fn(() => 0),
};

const createFile = (
  id: string,
  status: UploadStatus,
  overrides: Partial<UploadFile> = {},
): UploadFile =>
  ({
    id,
    fileName: `${id}.bin`,
    fileSize: 1024,
    fileType: "application/octet-stream",
    lastModified: 1700000000000,
    status,
    progress: 0,
    chunkSize: 1024 * 1024,
    chunkCount: 1,
    uploadedChunks: 0,
    pausedChunks: [],
    createdAt: 1700000000000,
    order: 0,
    // P2-4：带上当前 schema 版本，避免读取时触发迁移写回、
    // 干扰"恢复流程写入次数"的断言。
    schemaVersion: UPLOAD_SCHEMA_VERSION,
    ...overrides,
  }) as UploadFile;

describe("uploadStorage（T2.8 补齐）", () => {
  beforeEach(() => {
    iterateMock.mockReset();
    removeItemMock.mockReset();
    setItemMock.mockReset();
  });

  it("isUploadableStatus 覆盖全部分支（T3.3 状态机收敛后 PAUSED 需显式继续）", () => {
    // T3.3：可上传状态收敛为 QUEUED | QUEUED_FOR_UPLOAD | PREPARING_UPLOAD | UPLOADING | ERROR
    expect(isUploadableStatus(UploadStatus.QUEUED)).toBe(true);
    expect(isUploadableStatus(UploadStatus.QUEUED_FOR_UPLOAD)).toBe(true);
    expect(isUploadableStatus(UploadStatus.PREPARING_UPLOAD)).toBe(true);
    expect(isUploadableStatus(UploadStatus.UPLOADING)).toBe(true);
    expect(isUploadableStatus(UploadStatus.ERROR)).toBe(true);
    // PAUSED 不再自动续传：必须由用户点击「继续」触发 resume，避免与暂停中的 Worker 重复运行
    expect(isUploadableStatus(UploadStatus.PAUSED)).toBe(false);
    expect(isUploadableStatus(UploadStatus.DONE)).toBe(false);
    expect(isUploadableStatus(UploadStatus.INSTANT)).toBe(false);
  });

  it("listUploadFiles 过滤非 UploadFile 记录并按 createdAt 排序", async () => {
    iterateMock.mockImplementation(async (callback) => {
      callback(createFile("b", UploadStatus.DONE, { createdAt: 2 }), "b");
      callback("not-a-file", "junk");
      callback(null, "null-entry");
      callback(createFile("a", UploadStatus.QUEUED, { createdAt: 1 }), "a");
    });

    const files = await listUploadFiles(fakeStorage);

    expect(files.map((f) => f.id)).toEqual(["a", "b"]);
    expect(iterateMock).toHaveBeenCalledTimes(1);
  });

  it("removeUploadFilesByIds 空数组直接返回不触存储", async () => {
    await removeUploadFilesByIds([], fakeStorage, fakeRegistry);
    expect(removeItemMock).not.toHaveBeenCalled();
  });

  it("removeUploadFilesByIds 批量删除", async () => {
    await removeUploadFilesByIds(["a", "b", "c"], fakeStorage, fakeRegistry);
    expect(removeItemMock).toHaveBeenCalledTimes(3);
    expect(removeItemMock).toHaveBeenCalledWith("a");
    expect(removeItemMock).toHaveBeenCalledWith("c");
    expect(fakeRegistry.releaseFileRef).toHaveBeenCalledTimes(3);
  });

  it("recoverInterruptedUploadFiles：有 fileRef 的中断任务恢复到 QUEUED", async () => {
    iterateMock.mockImplementation(async (callback) => {
      callback(
        createFile("u1", UploadStatus.UPLOADING, {
          fileRef: new File([new Uint8Array(8)], "u1.bin"),
        }),
        "u1",
      );
      callback(createFile("done", UploadStatus.DONE), "done");
    });

    const summary = await recoverInterruptedUploadFiles(fakeStorage);

    expect(summary).toEqual({
      totalInterrupted: 1,
      recoveredCount: 1,
      missingFileRefCount: 0,
    });
    expect(setItemMock).toHaveBeenCalledTimes(1);
    const [, saved] = setItemMock.mock.calls[0]!;
    expect(saved.status).toBe(UploadStatus.QUEUED);
    expect(saved.errorMessage).toBeUndefined();
  });

  it("recoverInterruptedUploadFiles：fileRef 缺失标记 ERROR 且清空进度", async () => {
    iterateMock.mockImplementation(async (callback) => {
      callback(
        createFile("u2", UploadStatus.PREPARING_UPLOAD, { progress: 42 }),
        "u2",
      );
    });

    const summary = await recoverInterruptedUploadFiles(fakeStorage);

    expect(summary).toEqual({
      totalInterrupted: 1,
      recoveredCount: 0,
      missingFileRefCount: 1,
    });
    const [, saved] = setItemMock.mock.calls[0]!;
    expect(saved.status).toBe(UploadStatus.ERROR);
    expect(saved.progress).toBe(0);
    expect(saved.errorMessage).toContain("上传中断");
  });

  it("recoverInterruptedUploadFiles：无中断任务时零写入", async () => {
    iterateMock.mockImplementation(async (callback) => {
      callback(createFile("done-1", UploadStatus.DONE), "done-1");
      callback(createFile("instant-1", UploadStatus.INSTANT), "instant-1");
    });

    const summary = await recoverInterruptedUploadFiles(fakeStorage);

    expect(summary).toEqual({
      totalInterrupted: 0,
      recoveredCount: 0,
      missingFileRefCount: 0,
    });
    expect(setItemMock).not.toHaveBeenCalled();
  });

  describe("分片缓存（方案 A）：刷新零点击续传", () => {
    it("无 fileRef 但缓存就绪 → QUEUED，计入 recoveredCount", async () => {
      iterateMock.mockImplementation(async (callback) => {
        callback(createFile("cached", UploadStatus.UPLOADING), "cached");
      });

      const summary = await recoverInterruptedUploadFiles(fakeStorage, {
        listReadyFileIds: async () => new Set(["cached"]),
      });

      expect(summary).toEqual({
        totalInterrupted: 1,
        recoveredCount: 1,
        missingFileRefCount: 0,
      });
      const [, saved] = setItemMock.mock.calls[0]!;
      expect(saved.status).toBe(UploadStatus.QUEUED);
      expect(saved.awaitingReselect).toBe(false);
    });

    it("无 fileRef 且缓存缺失 → ERROR + awaitingReselect", async () => {
      iterateMock.mockImplementation(async (callback) => {
        callback(createFile("missing", UploadStatus.UPLOADING), "missing");
      });

      const summary = await recoverInterruptedUploadFiles(fakeStorage, {
        listReadyFileIds: async () => new Set(),
      });

      expect(summary).toEqual({
        totalInterrupted: 1,
        recoveredCount: 0,
        missingFileRefCount: 1,
      });
      const [, saved] = setItemMock.mock.calls[0]!;
      expect(saved.status).toBe(UploadStatus.ERROR);
      expect(saved.awaitingReselect).toBe(true);
      expect(saved.errorMessage).toContain("本地续传缓存缺失");
    });

    it("recoverUploadQueueOnMount：历史 QUEUED 命中缓存保持 QUEUED 且无需写回", async () => {
      iterateMock.mockImplementation(async (callback) => {
        callback(createFile("q-cached", UploadStatus.QUEUED), "q-cached");
      });

      const snapshot = await recoverUploadQueueOnMount(fakeStorage, {
        listReadyFileIds: async () => new Set(["q-cached"]),
      });

      expect(snapshot.files[0]?.status).toBe(UploadStatus.QUEUED);
      expect(snapshot.summary).toEqual({
        totalInterrupted: 1,
        recoveredCount: 1,
        missingFileRefCount: 0,
      });
      expect(snapshot.writeCount).toBe(0);
      expect(setItemMock).not.toHaveBeenCalled();
    });
  });

  describe("recoverUploadQueueOnMount（VU-39 单次快照恢复）", () => {
    it("一次 iterate 同时完成中断恢复与历史 QUEUED 治理，返回最终有序快照", async () => {
      iterateMock.mockImplementation(async (callback) => {
        callback(createFile("i1", UploadStatus.UPLOADING, { createdAt: 1 }), "i1");
        callback(createFile("q1", UploadStatus.QUEUED, { createdAt: 2 }), "q1");
        callback(createFile("d1", UploadStatus.DONE, { createdAt: 3 }), "d1");
      });

      const snapshot = await recoverUploadQueueOnMount(fakeStorage);

      // 旧链路是「恢复读 + 治理读 + refreshFiles 读」共 3 次全表遍历。
      expect(iterateMock).toHaveBeenCalledTimes(1);
      expect(snapshot.files.map((file) => file.id)).toEqual(["i1", "q1", "d1"]);
      // 缺 fileRef 的中断任务 → ERROR（保留缺缓存提示）
      expect(snapshot.files[0]?.status).toBe(UploadStatus.ERROR);
      expect(snapshot.files[0]?.errorMessage).toContain("上传中断");
      // 历史 QUEUED 行 → awaitingReselect 的 ERROR
      expect(snapshot.files[1]?.status).toBe(UploadStatus.ERROR);
      expect(snapshot.files[1]?.awaitingReselect).toBe(true);
      // 已完成文件完全不动
      expect(snapshot.files[2]?.status).toBe(UploadStatus.DONE);
      expect(snapshot.summary).toEqual({
        totalInterrupted: 1,
        recoveredCount: 0,
        missingFileRefCount: 1,
      });
      // 只写发生变化的 2 条，且每条只写最终态一次
      expect(snapshot.writeCount).toBe(2);
      expect(setItemMock).toHaveBeenCalledTimes(2);
    });

    it("写入并发发起，而不是逐个串行 await", async () => {
      iterateMock.mockImplementation(async (callback) => {
        callback(createFile("a", UploadStatus.UPLOADING), "a");
        callback(createFile("b", UploadStatus.QUEUED), "b");
      });

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      setItemMock.mockImplementation(async () => gate);

      const pending = recoverUploadQueueOnMount(fakeStorage);
      // gate 尚未 resolve 时两条写入都已发起 → 证明是 Promise.all 而非串行
      await vi.waitFor(() => expect(setItemMock).toHaveBeenCalledTimes(2));

      release();
      await pending;
      expect(iterateMock).toHaveBeenCalledTimes(1);
    });

    it("没有需要恢复 / 治理的记录时零写入，快照仍可直接采用", async () => {
      iterateMock.mockImplementation(async (callback) => {
        callback(createFile("done", UploadStatus.DONE), "done");
      });

      const snapshot = await recoverUploadQueueOnMount(fakeStorage);
      expect(snapshot.writeCount).toBe(0);
      expect(setItemMock).not.toHaveBeenCalled();
      expect(snapshot.files.map((file) => file.id)).toEqual(["done"]);
    });
  });
});
