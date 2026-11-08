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
      setItem: vi.fn(async () => undefined),
      getItem: vi.fn(async () => undefined),
      removeItem: vi.fn(async () => undefined),
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
  };
  const orchestrator = {
    loadAllUploadFiles: vi.fn(async () => [] as UploadFile[]),
    runConcurrentQueue: vi.fn(),
  };
  return { storeState, message, patchFile, engine, uploadContext, orchestrator };
});

vi.mock("../store/upload", () => ({
  useUploadStore: vi.fn(
    (selector: (s: typeof h.storeState) => unknown) => selector(h.storeState)
  ),
  useUploadStoreApi: vi.fn(),
  createUploadStore: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  UploadStoreContext: {} as any,
}));

vi.mock("../context/UploadEngineContext", () => ({
  useUploadEngine: vi.fn(() => h.engine),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  });
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
    h.orchestrator.loadAllUploadFiles.mockResolvedValue([]);
    h.orchestrator.runConcurrentQueue.mockReset();
  });

  it("clearBatchInfo 直接把 batchInfo 置空", () => {
    const { result } = renderHook(() => useBatchUploader());

    act(() => {
      result.current.clearBatchInfo();
    });

    expect(h.storeState.setBatchInfo).toHaveBeenCalledWith(null);
  });

  it("cancelUpload：取消在途/暂停文件、复位上传态并清 batchInfo", () => {
    const uploading = makeFile({ id: "up", status: UploadStatus.UPLOADING });
    const paused = makeFile({ id: "pa", status: UploadStatus.PAUSED });
    setEngineFiles([uploading, paused]);

    const { result } = renderHook(() => useBatchUploader());

    act(() => {
      result.current.cancelUpload();
    });

    // UPLOADING 文件触发 Worker 取消
    expect(h.engine.workerPool.cancelUploadTask).toHaveBeenCalledWith("up");
    // PAUSED 文件复位为 QUEUED 并写回存储
    expect(h.patchFile).toHaveBeenCalledWith("pa", {
      status: UploadStatus.QUEUED,
      errorMessage: undefined,
      awaitingReselect: false,
    });
    expect(h.engine.storage.setItem).toHaveBeenCalledWith(
      "pa",
      expect.objectContaining({ status: UploadStatus.QUEUED })
    );
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
});
