import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UploadEngine } from "../context/UploadEngineContext";
import { createUploadStore } from "../store/upload";
import { UploadStatus, type UploadFile } from "../types/upload";
import { useUploaderLifecycle } from "./useUploaderLifecycle";

const createHarness = () => {
  const store = createUploadStore({} as LocalForage);
  const engine = {
    store,
    storage: {},
    fileRegistry: {},
    workerPool: {},
  } as unknown as UploadEngine;
  const refreshFiles = vi.fn(async () => undefined);
  const render = () =>
    renderHook(() =>
      useUploaderLifecycle({
        engine,
        refreshFiles,
        setBatchInfo: vi.fn(),
        autoCleanup: false,
      }),
    );
  return { store, refreshFiles, render };
};

const makeFile = (overrides: Partial<UploadFile> = {}): UploadFile =>
  ({
    id: "f1",
    fileName: "f1.bin",
    fileSize: 100,
    fileType: "application/octet-stream",
    lastModified: 0,
    status: UploadStatus.QUEUED,
    progress: 0,
    chunkSize: 1024,
    chunkCount: 1,
    uploadedChunks: 0,
    pausedChunks: [],
    createdAt: 0,
    order: 0,
    ...overrides,
  }) as UploadFile;

describe("useUploaderLifecycle（VU-18 上传期不再周期全量读 IDB）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("syncFile 只做内存态局部替换，不触发任何全量读；flushRefresh 才对账一次", async () => {
    const { store, refreshFiles, render } = createHarness();
    store.getState().setFiles([makeFile()]);
    const { result } = render();

    act(() => {
      result.current.syncFile(
        makeFile({ status: UploadStatus.UPLOADING, progress: 42 }),
      );
    });

    expect(store.getState().files[0]?.status).toBe(UploadStatus.UPLOADING);
    expect(store.getState().files[0]?.progress).toBe(42);
    expect(refreshFiles).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.flushRefresh();
    });
    expect(refreshFiles).toHaveBeenCalledTimes(1);
  });

  it("多次状态转换 + 时间推进都不会产生 120ms 周期全量读", async () => {
    vi.useFakeTimers();
    const { store, refreshFiles, render } = createHarness();
    store.getState().setFiles([makeFile()]);
    const { result } = render();

    for (const progress of [10, 20, 30, 40, 50]) {
      act(() => {
        result.current.syncFile(
          makeFile({ status: UploadStatus.UPLOADING, progress }),
        );
      });
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(store.getState().files[0]?.progress).toBe(50);
    expect(refreshFiles).toHaveBeenCalledTimes(0);
  });

  it("syncFile 遇到 store 中不存在的新记录时退回一次全量对账", async () => {
    const { store, refreshFiles, render } = createHarness();
    store.getState().setFiles([]);
    const { result } = render();

    act(() => {
      result.current.syncFile(makeFile({ id: "brand-new" }));
    });

    await vi.waitFor(() => expect(refreshFiles).toHaveBeenCalledTimes(1));
  });

  it("beginBatchSession 会中止上一批，endBatchSession 只释放匹配的会话", () => {
    const { render } = createHarness();
    const { result } = render();

    const first = result.current.beginBatchSession();
    const second = result.current.beginBatchSession();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);

    result.current.endBatchSession(first);
    expect(result.current.activeUploadAbortRef.current).toBe(second);
    result.current.endBatchSession(second);
    expect(result.current.activeUploadAbortRef.current).toBeNull();
  });
});
