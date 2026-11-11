/**
 * useBatchUploaderController 行为断言单测（VU-58 收尾）。
 *
 * 通过 vi.mock 隔离 zustand store / 上传引擎 / 外部 context / 上传编排器 / 鉴权解析，
 * 仅验证该 hook 自身的核心状态转移与最重要 actions：cancel / pause / resume /
 * clearBatchInfo / retry 离线守卫 / uploadAll 批次状态机。不修改任何源码。
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UploadStatus, type UploadFile } from "../types/upload";
import {
  applyBeforeEach,
  createInitialBatchInfo,
} from "./uploadPolicy";

// 共享可控状态（hoisted 以便 mock 工厂引用）
const h = vi.hoisted(() => {
  const storeState = {
    isNetworkOffline: false,
    networkType: "unknown",
    fileConcurrency: 2,
    chunkConcurrency: 2,
    chunkSize: 1024 * 1024,
    maxRetries: 3,
    autoCleanup: false,
    refreshFiles: vi.fn(async () => undefined),
    setProgressDetail: vi.fn(),
    setBatchInfo: vi.fn(),
    setIsUploading: vi.fn(),
    getMessageApi: vi.fn(),
  };
  const message = {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  };
  const patchFile = vi.fn();
  const engine = {
    instanceId: "test",
    store: {
      getState: vi.fn(() => ({
        files: [] as UploadFile[],
        patchFile,
        progressMap: {} as Record<string, number>,
        setProgressDetail: storeState.setProgressDetail,
      })),
      setState: vi.fn(),
    },
    fileRegistry: {
      getFileRef: vi.fn(() => undefined),
      releaseFileRef: vi.fn(),
    },
    workerPool: {
      runUploadTask: vi.fn(),
      cancelUploadTask: vi.fn(),
      pauseUploadTask: vi.fn(),
      resumeUploadTask: vi.fn(() => true),
    },
    storage: {
      setItem: vi.fn(async (_id: string, _value: UploadFile) => undefined),
      // E2E-03：getItem 用于「记录是否仍存在」的守卫，默认视为存在。
      getItem: vi.fn(
        async (_id: string): Promise<UploadFile | null> => ({} as UploadFile)
      ),
      removeItem: vi.fn(async (_id: string) => undefined),
      clear: vi.fn(async () => undefined),
    },
  };
  const uploadContext = {
    baseURL: "",
    uploadApi: "",
    checkApi: "",
    mergeApi: "",
    chunkSize: 1024 * 1024,
    fileConcurrency: 2,
    chunkConcurrency: 2,
    maxRetries: 3,
    hashMode: "full" as const,
    maxFileSize: 100,
    allowedFileTypes: [] as string[],
    maxFiles: 100,
    autoUpload: true,
    autoCleanup: true,
    cleanupDelay: 10,
    networkDisplayMode: "tooltip" as const,
    uiMode: "full" as const,
    settingsSource: "props" as const,
    debug: false,
    visibleColumns: undefined,
    authToken: undefined,
    getAuthToken: undefined,
    getAuthHeaders: undefined,
    authScheme: undefined,
    withCredentials: false,
    // T-04：终态回调探针——用于断言「暂停/取消/删除后绝不能走成功或失败回调」。
    onUploadStart: vi.fn(),
    onUploadComplete: vi.fn(),
    onUploadError: vi.fn(),
    onBatchComplete: vi.fn(),
  };
  const orchestrator = {
    loadAllUploadFiles: vi.fn(async () => [] as UploadFile[]),
    runConcurrentQueue: vi.fn(),
  };
  /**
   * T-05：分片缓存探针。
   * 默认「预热已完成 + 缓存已就绪」，竞态用例才不会在「无 fileRef 且缓存未就绪」
   * 分支直接置 ERROR 返回；首字节延迟用例则把它改成永不 settle 来证明解耦。
   */
  const chunkCache = {
    primeChunkCache: vi.fn(async (): Promise<string> => "ready"),
    isFileCacheReady: vi.fn(async () => true),
    clearFileChunkCache: vi.fn(async () => undefined),
  };
  return { storeState, message, patchFile, engine, uploadContext, orchestrator, chunkCache };
});

vi.mock("../store/upload", () => ({
  useUploadStore: vi.fn(
    (selector: (s: typeof h.storeState) => unknown) => selector(h.storeState)
  ),
  useUploadStoreApi: vi.fn(),
  createUploadStore: vi.fn(),
   
  UploadStoreContext: {} as any,
}));

vi.mock("../context/UploadEngineContext", () => ({
  useUploadEngine: vi.fn(() => h.engine),
   
  UploadEngineContext: {} as any,
}));

vi.mock("../context/useUploadContext", () => ({
  useUploadContext: vi.fn(() => h.uploadContext),
}));

vi.mock("../services/uploadOrchestrator", () => ({
  loadAllUploadFiles: (...args: unknown[]) =>
    h.orchestrator.loadAllUploadFiles(...args),
  runConcurrentQueue: (...args: unknown[]) =>
    h.orchestrator.runConcurrentQueue(...args),
}));

vi.mock("../utils/auth", () => ({
  resolveAuthHeaders: vi.fn(async () => ({})),
}));

/**
 * T-05：分片缓存默认视为就绪。
 * 否则 processFileUpload 会在「无 fileRef 且缓存未就绪」分支直接置 ERROR 并返回，
 * 竞态用例根本走不到状态机，断言会退化成「缓存缺失」而非「竞态收敛」。
 * 具体行为由用例内 h.chunkCache.* 覆盖。
 */
vi.mock("../services/chunkCache", () => h.chunkCache);

import { useBatchUploader } from "./useBatchUploader";

const makeFile = (overrides: Partial<UploadFile> = {}): UploadFile =>
  ({
    id: "f1",
    fileName: "f1.bin",
    fileSize: 100,
    fileType: "application/octet-stream",
    lastModified: 0,
    status: UploadStatus.QUEUED,
    progress: 0,
    createdAt: 0,
    order: 0,
    ...overrides,
  }) as UploadFile;

/** 让 engine.store.getState() 返回稳定可控的对象（含当前 files 与同一 patchFile 实例）。 */
const setEngineFiles = (files: UploadFile[]) => {
  h.engine.store.getState.mockReturnValue({
    files,
    patchFile: h.patchFile,
    progressMap: {} as Record<string, number>,
    setProgressDetail: h.storeState.setProgressDetail,
  });
};

/* ==================== T-04 竞态用例的共用夹具 ==================== */

/** 带进度表的 engine 状态（暂停/取消分支会从 progressMap 取最新进度写回）。 */
const setEngineState = (
  files: UploadFile[],
  progressMap: Record<string, number> = {}
) => {
  h.engine.store.getState.mockReturnValue({
    files,
    patchFile: h.patchFile,
    progressMap,
    setProgressDetail: h.storeState.setProgressDetail,
  });
};

/**
 * 内存版 storage。
 * 「任务结束后是否写回」这类语义只能用真实可变的存储来断言：
 * 若用 mockResolvedValue 固定返回值，无论实现写不写回，断言都会通过。
 */
const useMemoryStorage = (initial: UploadFile[]) => {
  const map = new Map<string, UploadFile>(initial.map((f) => [f.id, { ...f }]));
  h.engine.storage.getItem.mockImplementation(
    async (id: string) => map.get(id) ?? null
  );
  h.engine.storage.setItem.mockImplementation(
    async (id: string, value: UploadFile) => {
      map.set(id, value);
    }
  );
  return map;
};

/**
 * 串行队列替身：严格按真实编排器的顺序 beforeEach → task → onSettled。
 * T-14：`beforeEach` 返回 "skip" 时跳过该件（不计成功/失败，只记 skippedCount）。
 */
const runQueueSerial = async (opts: {
  items: UploadFile[];
  beforeEach?: (f: UploadFile, i: number) => Promise<"skip" | void>;
  task: (f: UploadFile, i: number) => Promise<boolean>;
  onSettled?: (r: {
    item: UploadFile;
    index: number;
    success: boolean;
    skipped?: boolean;
  }) => Promise<void> | void;
}) => {
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  for (const [index, item] of opts.items.entries()) {
    if ((await opts.beforeEach?.(item, index)) === "skip") {
      skippedCount += 1;
      await opts.onSettled?.({ item, index, success: false, skipped: true });
      continue;
    }
    const success = await opts.task(item, index);
    if (success) {
      successCount += 1;
    } else {
      failedCount += 1;
    }
    await opts.onSettled?.({ item, index, success });
  }
  return { successCount, failedCount, skippedCount };
};

describe("useBatchUploader（核心状态转移与动作断言）", () => {
  beforeEach(() => {
    h.storeState.isNetworkOffline = false;
    h.storeState.autoCleanup = false;
    h.storeState.getMessageApi.mockReturnValue(h.message);
    h.storeState.refreshFiles.mockResolvedValue(undefined);
    h.storeState.setBatchInfo.mockClear();
    h.storeState.setIsUploading.mockClear();
    h.patchFile.mockClear();
    setEngineFiles([]);
    h.engine.fileRegistry.getFileRef.mockReturnValue(undefined);
    h.engine.workerPool.runUploadTask.mockReset();
    h.engine.workerPool.cancelUploadTask.mockClear();
    h.engine.workerPool.pauseUploadTask.mockClear();
    h.engine.workerPool.resumeUploadTask.mockReturnValue(true);
    h.engine.storage.setItem.mockResolvedValue(undefined);
    h.engine.storage.getItem.mockResolvedValue({} as UploadFile);
    h.orchestrator.loadAllUploadFiles.mockResolvedValue([]);
    h.orchestrator.runConcurrentQueue.mockReset();
    h.chunkCache.primeChunkCache.mockReset();
    h.chunkCache.primeChunkCache.mockResolvedValue("ready");
    h.chunkCache.isFileCacheReady.mockReset();
    h.chunkCache.isFileCacheReady.mockResolvedValue(true);
    h.uploadContext.onUploadStart.mockClear();
    h.uploadContext.onUploadComplete.mockClear();
    h.uploadContext.onUploadError.mockClear();
    h.uploadContext.onBatchComplete.mockClear();
  });

  it("clearBatchInfo 直接把 batchInfo 置空", () => {
    const { result } = renderHook(() => useBatchUploader());

    act(() => {
      result.current.clearBatchInfo();
    });

    expect(h.storeState.setBatchInfo).toHaveBeenCalledWith(null);
  });

  it("cancelUpload：在途/暂停文件统一落定为已暂停、速率归零并清 batchInfo", () => {
    const uploading = makeFile({ id: "up", status: UploadStatus.UPLOADING });
    const paused = makeFile({ id: "pa", status: UploadStatus.PAUSED });
    setEngineFiles([uploading, paused]);

    const { result } = renderHook(() => useBatchUploader());

    act(() => {
      result.current.cancelUpload();
    });

    // F-01：在飞行的文件都要向 Worker 发取消，避免任务悬挂
    expect(h.engine.workerPool.cancelUploadTask).toHaveBeenCalledWith("up");
    expect(h.engine.workerPool.cancelUploadTask).toHaveBeenCalledWith("pa");
    // 两者都落定为 PAUSED（不再是「暂停复位为排队中」的旧口径）
    expect(h.patchFile).toHaveBeenCalledWith("up", {
      status: UploadStatus.PAUSED,
      errorMessage: undefined,
      awaitingReselect: false,
    });
    expect(h.patchFile).toHaveBeenCalledWith("pa", {
      status: UploadStatus.PAUSED,
      errorMessage: undefined,
      awaitingReselect: false,
    });
    expect(h.engine.storage.setItem).toHaveBeenCalledWith(
      "pa",
      expect.objectContaining({ status: UploadStatus.PAUSED })
    );
    // F-01：速率/ETA 归零，避免暂停后仍显示冻结速率
    expect(h.storeState.setProgressDetail).toHaveBeenCalledWith("up", {
      progress: 0,
      speed: 0,
      eta: 0,
    });
    expect(h.storeState.setIsUploading).toHaveBeenCalledWith(false);
    expect(h.storeState.setBatchInfo).toHaveBeenCalledWith(null);
  });

  it("pauseUploadFile：仅当 UPLOADING 时乐观置 PAUSED 并通知 Worker", async () => {
    const uploading = makeFile({ id: "up", status: UploadStatus.UPLOADING });
    const { result } = renderHook(() => useBatchUploader());

    await act(async () => {
      await result.current.pauseUploadFile(uploading);
    });

    expect(h.patchFile).toHaveBeenCalledWith("up", {
      status: UploadStatus.PAUSED,
      errorMessage: undefined,
    });
    expect(h.engine.storage.setItem).toHaveBeenCalledWith(
      "up",
      expect.objectContaining({ status: UploadStatus.PAUSED })
    );
    expect(h.engine.workerPool.pauseUploadTask).toHaveBeenCalledWith("up");
  });

  it("cancelUploadFile：中止传输但保留记录（PAUSED），可继续（E2E-R4）", async () => {
    const uploading = makeFile({ id: "up", status: UploadStatus.UPLOADING });
    const { result } = renderHook(() => useBatchUploader());

    await act(async () => {
      await result.current.cancelUploadFile(uploading);
    });

    // 记录保留：置 PAUSED（行内出现「继续」），不写错误、不删除记录
    expect(h.patchFile).toHaveBeenCalledWith("up", {
      status: UploadStatus.PAUSED,
      errorMessage: undefined,
    });
    expect(h.engine.storage.setItem).toHaveBeenCalledWith(
      "up",
      expect.objectContaining({ status: UploadStatus.PAUSED })
    );
    expect(h.engine.workerPool.cancelUploadTask).toHaveBeenCalledWith("up");
    expect(h.message.info).toHaveBeenCalledWith(
      expect.stringContaining("已取消")
    );

    // 非 UPLOADING 状态为 no-op，避免误取消已完成/暂停的文件
    h.engine.workerPool.cancelUploadTask.mockClear();
    await act(async () => {
      await result.current.cancelUploadFile(
        makeFile({ id: "done", status: UploadStatus.DONE })
      );
    });
    expect(h.engine.workerPool.cancelUploadTask).not.toHaveBeenCalled();
  });

  it("pauseUploadFile：非 UPLOADING 文件为 no-op", async () => {
    const done = makeFile({ id: "d", status: UploadStatus.DONE });
    const { result } = renderHook(() => useBatchUploader());

    await act(async () => {
      await result.current.pauseUploadFile(done);
    });

    expect(h.patchFile).not.toHaveBeenCalled();
    expect(h.engine.workerPool.pauseUploadTask).not.toHaveBeenCalled();
  });

  it("resumeUploadFile：PAUSED 且 Worker 仍存活时恢复为 UPLOADING", async () => {
    const paused = makeFile({ id: "pa", status: UploadStatus.PAUSED });
    h.engine.workerPool.resumeUploadTask.mockReturnValue(true);
    const { result } = renderHook(() => useBatchUploader());

    await act(async () => {
      await result.current.resumeUploadFile(paused);
    });

    expect(h.engine.workerPool.resumeUploadTask).toHaveBeenCalledWith("pa");
    expect(h.patchFile).toHaveBeenCalledWith("pa", {
      status: UploadStatus.UPLOADING,
      errorMessage: undefined,
    });
    expect(h.engine.storage.setItem).toHaveBeenCalledWith(
      "pa",
      expect.objectContaining({ status: UploadStatus.UPLOADING })
    );
  });

  it("resumeUploadFile：非 PAUSED 文件为 no-op", async () => {
    const queued = makeFile({ id: "q", status: UploadStatus.QUEUED });
    const { result } = renderHook(() => useBatchUploader());

    await act(async () => {
      await result.current.resumeUploadFile(queued);
    });

    expect(h.engine.workerPool.resumeUploadTask).not.toHaveBeenCalled();
    expect(h.patchFile).not.toHaveBeenCalled();
  });

  it("retryUploadFile：离线时直接返回失败且不触发上传链路", async () => {
    h.storeState.isNetworkOffline = true;
    const file = makeFile();
    const { result } = renderHook(() => useBatchUploader());

    let ret: { success: boolean; message: string } | null = null;
    await act(async () => {
      ret = await result.current.retryUploadFile(file);
    });

    expect(ret).toEqual({
      success: false,
      message: "网络已断开，无法重试上传",
    });
    expect(h.engine.fileRegistry.getFileRef).not.toHaveBeenCalled();
    expect(h.engine.workerPool.runUploadTask).not.toHaveBeenCalled();
  });

  it("T-07：retryUploadFile 不原地改写传入的 store 对象，改写落在 draft 上", async () => {
    // 入参就是 store.files 里的那个对象（行组件把 props.file 直接传进来）。
    const storeFile = makeFile({
      id: "r1",
      status: UploadStatus.ERROR,
      progress: 37,
      errorMessage: "上传失败",
    });
    const before = { ...storeFile };
    const persistedMap = useMemoryStorage([storeFile]);
    setEngineState([storeFile]);
    // Worker 直接报成功，让整条链路走完
    h.engine.workerPool.runUploadTask.mockResolvedValue({ success: true });

    const { result } = renderHook(() => useBatchUploader());
    await act(async () => {
      await result.current.retryUploadFile(storeFile);
    });

    // 1) 原对象零改动 —— 旧实现直接改它（status/progress/errorMessage 三处），
    //    数组引用不变 → Zustand 不通知 → 行组件拿不到新 props，不会重渲染。
    expect(storeFile).toEqual(before);

    // 2) 落盘与同步都用新引用：patchFile 收到的是副本，不是 store 里那个对象
    const patchArg = h.patchFile.mock.calls.at(-1)![1] as UploadFile;
    expect(patchArg).not.toBe(storeFile);
    expect(patchArg.id).toBe("r1");

    // 3) 持久化记录已推进到终态（draft 走完整条链）
    expect(persistedMap.get("r1")!.status).toBe(UploadStatus.DONE);
  });

  it("retryAllFailedFiles：离线时直接返回失败且不读取文件", async () => {
    h.storeState.isNetworkOffline = true;
    const { result } = renderHook(() => useBatchUploader());

    let ret: { success: boolean; message: string; retriedCount: number } | null =
      null;
    await act(async () => {
      ret = await result.current.retryAllFailedFiles();
    });

    expect(ret).toEqual({
      success: false,
      message: "网络已断开，无法重试上传",
      retriedCount: 0,
    });
    expect(h.orchestrator.loadAllUploadFiles).not.toHaveBeenCalled();
  });

  it("uploadAll：只拾取自动可上传状态，历史 ERROR 记录需用户显式重试（E2E-R3）", async () => {
    const failed = makeFile({ id: "failed", status: UploadStatus.ERROR });
    const queued = makeFile({ id: "queued", status: UploadStatus.QUEUED });
    h.orchestrator.loadAllUploadFiles.mockResolvedValue([failed, queued]);
    h.orchestrator.runConcurrentQueue.mockResolvedValue({
      successCount: 1,
      failedCount: 0,
    });

    const { result } = renderHook(() => useBatchUploader());

    await act(async () => {
      await result.current.uploadAll();
    });

    const queuedItems = h.orchestrator.runConcurrentQueue.mock.calls.at(-1)![0]
      .items as UploadFile[];
    expect(queuedItems.map((file) => file.id)).toEqual(["queued"]);
    expect(h.storeState.setBatchInfo).toHaveBeenCalledWith(
      createInitialBatchInfo(1)
    );
  });

  it("uploadAll：批次状态机——初始批次信息→并发结算→收尾完成", async () => {
    const queued = makeFile({ id: "q", status: UploadStatus.QUEUED });
    h.orchestrator.loadAllUploadFiles.mockResolvedValue([queued]);
    // 模拟编排器：对每个文件调用 beforeEach 与 onSettled（成功），但不真正跑 task
    h.orchestrator.runConcurrentQueue.mockImplementation(
      async (opts: {
        items: UploadFile[];
        beforeEach?: (f: UploadFile, i: number) => Promise<void>;
        onSettled?: (r: {
          item: UploadFile;
          index: number;
          success: boolean;
        }) => Promise<void>;
      }) => {
        let successCount = 0;
        for (const item of opts.items) {
          await opts.beforeEach?.(item, 0);
          successCount += 1;
          await opts.onSettled?.({ item, index: 0, success: true });
        }
        return { successCount, failedCount: 0 };
      }
    );

    const { result } = renderHook(() => useBatchUploader());

    let ret = false;
    await act(async () => {
      ret = await result.current.uploadAll();
    });

    expect(ret).toBe(true);
    expect(h.orchestrator.loadAllUploadFiles).toHaveBeenCalledTimes(1);
    // 起始批次信息：total=1
    expect(h.storeState.setBatchInfo).toHaveBeenCalledWith(
      createInitialBatchInfo(1)
    );
    // beforeEach 写入 applyBeforeEach（onSettled 以箭头包裹 applySettled，故只校验前者）
    expect(h.storeState.setBatchInfo).toHaveBeenCalledWith(applyBeforeEach);
    expect(h.storeState.setIsUploading).toHaveBeenNthCalledWith(1, true);
    expect(h.storeState.setIsUploading).toHaveBeenLastCalledWith(false);
    // 收尾：applyFinalized 落定 completed=1 / failed=0
    const finalUpdater = h.storeState.setBatchInfo.mock.calls.at(-1)![0] as (
      prev: ReturnType<typeof createInitialBatchInfo> | null
    ) => {
      current: number;
      total: number;
      queued: number;
      active: number;
      completed: number;
      failed: number;
    };
    const finalized = finalUpdater(createInitialBatchInfo(1));
    expect(finalized.completed).toBe(1);
    expect(finalized.failed).toBe(0);
    expect(finalized.current).toBe(1);
    expect(finalized.queued).toBe(0);
    expect(finalized.active).toBe(0);
  });

  it("uploadAll：无可上传文件时提示并直接返回 false", async () => {
    h.orchestrator.loadAllUploadFiles.mockResolvedValue([]);
    const { result } = renderHook(() => useBatchUploader());

    let ret = true;
    await act(async () => {
      ret = await result.current.uploadAll();
    });

    expect(ret).toBe(false);
    expect(h.message.info).toHaveBeenCalledWith("没有需要上传的文件");
    expect(h.orchestrator.runConcurrentQueue).not.toHaveBeenCalled();
    expect(h.storeState.setIsUploading).toHaveBeenCalledWith(false);
  });

  it("uploadAll：排队期间记录被删除时不再写回、不启动上传（E2E-03）", async () => {
    const queued = makeFile({ id: "gone", status: UploadStatus.QUEUED });
    h.orchestrator.loadAllUploadFiles.mockResolvedValue([queued]);
    h.engine.storage.getItem.mockResolvedValue(null);
    h.orchestrator.runConcurrentQueue.mockImplementation(
      async (opts: {
        items: UploadFile[];
        beforeEach?: (f: UploadFile, i: number) => Promise<void>;
        task: (f: UploadFile, i: number) => Promise<boolean>;
        onSettled?: (r: {
          item: UploadFile;
          index: number;
          success: boolean;
        }) => Promise<void> | void;
      }) => {
        let failedCount = 0;
        for (const item of opts.items) {
          await opts.beforeEach?.(item, 0);
          const success = await opts.task(item, 0);
          if (!success) failedCount += 1;
          await opts.onSettled?.({ item, index: 0, success });
        }
        return { successCount: 0, failedCount };
      }
    );

    const { result } = renderHook(() => useBatchUploader());

    await act(async () => {
      await result.current.uploadAll();
    });

    expect(h.engine.workerPool.runUploadTask).not.toHaveBeenCalled();
    expect(h.engine.storage.setItem).not.toHaveBeenCalled();
  });

  it("uploadAll：离线时直接报错并返回 false", async () => {
    h.storeState.isNetworkOffline = true;
    const { result } = renderHook(() => useBatchUploader());

    let ret = true;
    await act(async () => {
      ret = await result.current.uploadAll();
    });

    expect(ret).toBe(false);
    expect(h.message.error).toHaveBeenCalledWith("网络已断开，无法上传文件");
    expect(h.orchestrator.loadAllUploadFiles).not.toHaveBeenCalled();
  });

  /* ================== T-04：三条竞态回归（TC-210 / 211 / 212） ================== */

  it("TC-210 暂停在途分片收尾：落 PAUSED 且保留进度，不写错误文案、不触发失败回调", async () => {
    const file = makeFile({ id: "p1", status: UploadStatus.QUEUED, progress: 40 });
    const store = useMemoryStorage([file]);
    setEngineState([file], { p1: 62 });
    h.orchestrator.loadAllUploadFiles.mockResolvedValue([file]);
    h.orchestrator.runConcurrentQueue.mockImplementation(runQueueSerial);
    // 用户点「暂停」后，Worker 在分片边界收尾：paused + 已完成的 2 个分片
    h.engine.workerPool.runUploadTask.mockResolvedValue({
      paused: true,
      pausedChunks: 2,
    });

    const { result } = renderHook(() => useBatchUploader());
    await act(async () => {
      await result.current.uploadAll();
    });

    const persisted = store.get("p1")!;
    // 核心断言：暂停是「可继续的中断」，不是失败
    expect(persisted.status).toBe(UploadStatus.PAUSED);
    expect(persisted.errorMessage).toBeUndefined();
    expect(persisted.awaitingReselect).toBe(false);
    // 进度取 progressMap 的最新采样（不是 beforeEach 归零后的 0）
    expect(persisted.progress).toBe(62);
    expect(persisted.pausedChunks).toEqual([0, 1]);
    expect(h.uploadContext.onUploadError).not.toHaveBeenCalled();
    expect(h.uploadContext.onUploadComplete).not.toHaveBeenCalled();
    // T-32：暂停是可继续的中断，onBatchComplete 不得报「1 个失败」
    expect(h.uploadContext.onBatchComplete).toHaveBeenCalledWith(
      expect.objectContaining({ success: 0, failed: 0, total: 1 })
    );
  });

  it("T-33 宿主 onUploadComplete 抛异常：已落 DONE 的文件仍计成功，批次正常结算", async () => {
    const file = makeFile({ id: "host-boom", status: UploadStatus.QUEUED });
    const store = useMemoryStorage([file]);
    setEngineState([file], {});
    h.orchestrator.loadAllUploadFiles.mockResolvedValue([file]);
    h.orchestrator.runConcurrentQueue.mockImplementation(runQueueSerial);
    h.engine.workerPool.runUploadTask.mockResolvedValue({ success: true });
    h.uploadContext.onUploadComplete.mockImplementationOnce(() => {
      throw new Error("host callback boom");
    });

    const { result } = renderHook(() => useBatchUploader());
    await act(async () => {
      await result.current.uploadAll();
    });

    expect(store.get("host-boom")!.status).toBe(UploadStatus.DONE);
    expect(h.uploadContext.onBatchComplete).toHaveBeenCalledWith(
      expect.objectContaining({ success: 1, failed: 0, total: 1 })
    );
  });

  it("T-33 编排器抛异常时 finally 兜底复位 isUploading，且不产生未处理拒绝", async () => {
    const file = makeFile({ id: "queue-boom", status: UploadStatus.QUEUED });
    setEngineState([file], {});
    h.orchestrator.loadAllUploadFiles.mockResolvedValue([file]);
    h.orchestrator.runConcurrentQueue.mockRejectedValue(new Error("queue boom"));

    const { result } = renderHook(() => useBatchUploader());
    await act(async () => {
      await expect(result.current.uploadAll()).rejects.toThrow("queue boom");
    });

    expect(h.storeState.setIsUploading).toHaveBeenCalledWith(false);
  });

  it("TC-211 任务结束前记录被删除：Worker 报成功也不写回，列表不复活（E2E-03）", async () => {
    const file = makeFile({ id: "gone", status: UploadStatus.QUEUED });
    const store = useMemoryStorage([file]);
    setEngineState([file], { gone: 30 });
    h.orchestrator.loadAllUploadFiles.mockResolvedValue([file]);
    h.orchestrator.runConcurrentQueue.mockImplementation(runQueueSerial);
    // 上传进行中用户点了「删除」：记录从持久化层消失，随后 Worker 才回报成功
    h.engine.workerPool.runUploadTask.mockImplementation(async () => {
      store.delete("gone");
      return { success: true };
    });

    const { result } = renderHook(() => useBatchUploader());
    await act(async () => {
      await result.current.uploadAll();
    });

    // 关键：旧实现会把内存里的 file 对象重新 setItem，刷新后这条记录「复活」并继续上传
    expect(store.has("gone")).toBe(false);
    expect(h.uploadContext.onUploadComplete).not.toHaveBeenCalled();
  });

  it("TC-212 用户取消与 Worker 错误同时抵达：按 cancelled 归类（落 PAUSED），且不计入批量失败", async () => {
    const file = makeFile({ id: "race", status: UploadStatus.QUEUED });
    const store = useMemoryStorage([file]);
    setEngineState([file], { race: 55 });
    h.orchestrator.loadAllUploadFiles.mockResolvedValue([file]);
    h.orchestrator.runConcurrentQueue.mockImplementation(runQueueSerial);

    let actions: ReturnType<typeof useBatchUploader> | null = null;
    h.engine.workerPool.runUploadTask.mockImplementation(async (task) => {
      // 用户恰在此刻点「取消」：写入 userCancelledIds / cancelledInBatchIds
      await actions!.cancelUploadFile(task.file);
      // 同一结果里还带着错误文案——两条信号竞态，cancelled 必须优先
      return { cancelled: true, errorMessage: "分片上传失败" };
    });

    const { result } = renderHook(() => useBatchUploader());
    actions = result.current;
    await act(async () => {
      await result.current.uploadAll();
    });

    const persisted = store.get("race")!;
    expect(persisted.status).toBe(UploadStatus.PAUSED);
    // 取消不该留下「分片上传失败」这类误导性文案
    expect(persisted.errorMessage).toBeUndefined();
    expect(h.uploadContext.onUploadError).not.toHaveBeenCalled();
    // 取消既不算成功也不算失败：从 summary.failedCount 中剔除
    expect(h.uploadContext.onBatchComplete).toHaveBeenCalledWith({
      success: 0,
      failed: 0,
      total: 1,
      skipped: 0,
    });
  });

  it("T-14 排队中被删的文件记为「已跳过」，不计入失败（3 入队 / 删 2）", async () => {
    const a = makeFile({ id: "a", status: UploadStatus.QUEUED });
    const b = makeFile({ id: "b", status: UploadStatus.QUEUED });
    const c = makeFile({ id: "c", status: UploadStatus.QUEUED });
    const store = useMemoryStorage([a, b, c]);
    setEngineState([a, b, c]);
    h.orchestrator.loadAllUploadFiles.mockResolvedValue([a, b, c]);
    h.orchestrator.runConcurrentQueue.mockImplementation(runQueueSerial);
    h.engine.workerPool.runUploadTask.mockResolvedValue({ success: true });

    // 队列刚跑起来，用户就把 b、c 删了：beforeEach 读不到记录 → 跳过
    store.delete("b");
    store.delete("c");

    const { result } = renderHook(() => useBatchUploader());
    await act(async () => {
      await result.current.uploadAll();
    });

    // 旧实现：跳过的两件走 task 的 false → failed 变 2，用户会看到「2 个失败」
    expect(h.uploadContext.onBatchComplete).toHaveBeenCalledWith({
      success: 1,
      failed: 0,
      total: 3,
      skipped: 2,
    });
    // 跳过的文件不会有任何写回（旧实现也可能在 task 里误写 PREPARING）
    expect(store.has("b")).toBe(false);
    expect(store.has("c")).toBe(false);
  });

  /* ================== T-05：首字节延迟与文件大小解耦（预热并行化） ================== */

  it("T-05 预热未完成也立即开始上传：首字节不再等待全量缓存落盘", async () => {
    const file = makeFile({ id: "prewarm", status: UploadStatus.QUEUED });
    const store = useMemoryStorage([file]);
    setEngineState([file]);
    h.orchestrator.loadAllUploadFiles.mockResolvedValue([file]);
    h.orchestrator.runConcurrentQueue.mockImplementation(runQueueSerial);
    // 会话内上传：字节来自 fileRef，缓存只决定「刷新后能否零点击续传」
    h.engine.fileRegistry.getFileRef.mockReturnValue(
      new File([new Uint8Array(4)], "prewarm.bin")
    );
    // 模拟大文件预热迟迟不落盘：Promise 永不 settle。
    // 旧实现在置 UPLOADING 之前 await 它 → 本用例会卡到超时（红）；
    // 新实现把它留在后台 → 上传照常跑完（绿）。
    h.chunkCache.primeChunkCache.mockReturnValue(new Promise(() => undefined));
    h.engine.workerPool.runUploadTask.mockResolvedValue({ success: true });

    const { result } = renderHook(() => useBatchUploader());
    await act(async () => {
      await result.current.uploadAll();
    });

    expect(h.engine.workerPool.runUploadTask).toHaveBeenCalledTimes(1);
    // 预热没有被取消，仍在后台推进（零点击续传能力最终仍会具备）
    expect(h.chunkCache.primeChunkCache).toHaveBeenCalledTimes(1);
    expect(store.get("prewarm")!.status).toBe(UploadStatus.DONE);
  });

  it("T-05 刷新后续传：无 fileRef 且缓存未就绪时明确降级重选，不发任何分片请求", async () => {
    const file = makeFile({ id: "nocache", status: UploadStatus.QUEUED });
    const store = useMemoryStorage([file]);
    setEngineState([file]);
    h.orchestrator.loadAllUploadFiles.mockResolvedValue([file]);
    h.orchestrator.runConcurrentQueue.mockImplementation(runQueueSerial);
    // 刷新后 fileRef 丢失：缓存成为唯一字节来源
    h.engine.fileRegistry.getFileRef.mockReturnValue(undefined);
    h.chunkCache.isFileCacheReady.mockResolvedValue(false);

    const { result } = renderHook(() => useBatchUploader());
    await act(async () => {
      await result.current.uploadAll();
    });

    expect(h.engine.workerPool.runUploadTask).not.toHaveBeenCalled();
    // 这条分支不接受「缓存不完整就开始传」：缺片合并会产出静默损坏的文件
    expect(h.chunkCache.primeChunkCache).not.toHaveBeenCalled();
    const persisted = store.get("nocache")!;
    expect(persisted.status).toBe(UploadStatus.ERROR);
    expect(persisted.awaitingReselect).toBe(true);
    expect(persisted.errorMessage).toContain("本地续传缓存缺失");
  });
});
