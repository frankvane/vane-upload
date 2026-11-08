/**
 * useFileOperations 行为断言单测（VU-58 收尾）。
 *
 * 通过 vi.mock 隔离 zustand store / 上传引擎 / messageApi，仅验证该 hook 自身逻辑：
 * 各 action 的副作用顺序、返回值，以及错误分支（catch）的提示文案。
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadFile } from "../types/upload";

// 共享的可控状态（hoisted 以便 mock 工厂引用）
const h = vi.hoisted(() => ({
  storeState: {
    retryingFiles: {} as Record<string, boolean>,
    isRetryingAll: false,
    refreshFiles: vi.fn(async () => undefined),
    getMessageApi: vi.fn(),
    setRetryingFiles: vi.fn(),
    setIsRetryingAll: vi.fn(),
  },
  message: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
  engine: {
    storage: {
      removeItem: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    },
  },
  retryUploadFile: vi.fn(),
  retryAllFailedFiles: vi.fn(),
}));

vi.mock("../store/upload", () => ({
  useUploadStore: vi.fn((selector: (s: typeof h.storeState) => unknown) =>
    selector(h.storeState)
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

import { useFileOperations } from "./useFileOperations";

const makeFile = (overrides: Partial<UploadFile> = {}): UploadFile =>
  ({
    id: "f1",
    fileName: "f1.bin",
    fileSize: 100,
    fileType: "application/octet-stream",
    lastModified: 0,
    status: "queued" as UploadFile["status"],
    progress: 0,
    createdAt: 0,
    order: 0,
    ...overrides,
  }) as UploadFile;

const makeBatch = () => ({
  retryUploadFile: h.retryUploadFile as unknown as (
    f: UploadFile
  ) => Promise<{ success: boolean; message: string }>,
  retryAllFailedFiles: h.retryAllFailedFiles as unknown as () => Promise<{
    success: boolean;
    message: string;
    retriedCount: number;
  }>,
});

describe("useFileOperations（动作与错误分支断言）", () => {
  beforeEach(() => {
    h.storeState.retryingFiles = {};
    h.storeState.isRetryingAll = false;
    h.storeState.getMessageApi.mockReturnValue(h.message);
    h.storeState.refreshFiles.mockResolvedValue(undefined);
    h.engine.storage.removeItem.mockResolvedValue(undefined);
    h.engine.storage.clear.mockResolvedValue(undefined);
    h.retryUploadFile.mockResolvedValue({ success: true, message: "ok" });
    h.retryAllFailedFiles.mockResolvedValue({
      success: true,
      message: "all-ok",
      retriedCount: 1,
    });
  });

  it("返回对象包含预期的 actions 与状态字段", () => {
    const { result } = renderHook(() => useFileOperations(makeBatch()));

    expect(typeof result.current.handleDeleteFile).toBe("function");
    expect(typeof result.current.handleRetryUpload).toBe("function");
    expect(typeof result.current.handleClearList).toBe("function");
    expect(typeof result.current.handleRetryAllUpload).toBe("function");
    expect(result.current.retryingFiles).toEqual({});
    expect(result.current.isRetryingAll).toBe(false);
  });

  it("handleDeleteFile 成功：移除存储 + 刷新 + 成功提示", async () => {
    const { result } = renderHook(() => useFileOperations(makeBatch()));

    await act(async () => {
      await result.current.handleDeleteFile("f1");
    });

    expect(h.engine.storage.removeItem).toHaveBeenCalledWith("f1");
    expect(h.storeState.refreshFiles).toHaveBeenCalledTimes(1);
    expect(h.message.success).toHaveBeenCalledWith("文件已删除");
    expect(h.message.error).not.toHaveBeenCalled();
  });

  it("handleDeleteFile 失败：进入 catch 并显示错误提示", async () => {
    h.engine.storage.removeItem.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useFileOperations(makeBatch()));

    await act(async () => {
      await result.current.handleDeleteFile("f1");
    });

    expect(h.message.error).toHaveBeenCalledWith("删除文件失败");
    expect(h.message.success).not.toHaveBeenCalled();
  });

  it("handleRetryUpload 成功：置位/清位 retryingFiles 并提示成功", async () => {
    const file = makeFile();
    const { result } = renderHook(() => useFileOperations(makeBatch()));

    await act(async () => {
      await result.current.handleRetryUpload(file);
    });

    expect(h.retryUploadFile).toHaveBeenCalledWith(file);
    // 置位一次（true）与清位一次（delete）
    expect(h.storeState.setRetryingFiles).toHaveBeenCalledTimes(2);
    const setUpdater = h.storeState.setRetryingFiles.mock.calls[0]![0];
    expect(setUpdater({})).toEqual({ [file.id]: true });
    const clearUpdater = h.storeState.setRetryingFiles.mock.calls[1]![0];
    expect(clearUpdater({ [file.id]: true })).toEqual({});
    expect(h.message.success).toHaveBeenCalledWith("ok");
  });

  it("handleRetryUpload 失败：仍清理标记并提示失败信息", async () => {
    h.retryUploadFile.mockResolvedValue({ success: false, message: "bad" });
    const file = makeFile();
    const { result } = renderHook(() => useFileOperations(makeBatch()));

    await act(async () => {
      await result.current.handleRetryUpload(file);
    });

    expect(h.storeState.setRetryingFiles).toHaveBeenCalledTimes(2);
    expect(h.message.error).toHaveBeenCalledWith("bad");
  });

  it("handleClearList 成功：清空存储 + 刷新 + 成功提示并返回 true", async () => {
    const { result } = renderHook(() => useFileOperations(makeBatch()));

    let returned = false;
    await act(async () => {
      returned = await result.current.handleClearList();
    });

    expect(h.engine.storage.clear).toHaveBeenCalledTimes(1);
    expect(h.storeState.refreshFiles).toHaveBeenCalledTimes(1);
    expect(h.message.success).toHaveBeenCalledWith("文件列表已清空");
    expect(returned).toBe(true);
  });

  it("handleClearList 失败：错误提示并返回 false", async () => {
    h.engine.storage.clear.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useFileOperations(makeBatch()));

    let returned = true;
    await act(async () => {
      returned = await result.current.handleClearList();
    });

    expect(h.message.error).toHaveBeenCalledWith("清空文件列表失败");
    expect(returned).toBe(false);
  });

  it("handleRetryAllUpload：setIsRetryingAll 先 true 后 false，按结果提示", async () => {
    const { result } = renderHook(() => useFileOperations(makeBatch()));

    let ret: { success: boolean; message: string; retriedCount: number } | null =
      null;
    await act(async () => {
      ret = await result.current.handleRetryAllUpload();
    });

    expect(h.storeState.setIsRetryingAll).toHaveBeenNthCalledWith(1, true);
    expect(h.storeState.setIsRetryingAll).toHaveBeenLastCalledWith(false);
    expect(h.retryAllFailedFiles).toHaveBeenCalledTimes(1);
    expect(h.message.success).toHaveBeenCalledWith("all-ok");
    expect(ret).toEqual({ success: true, message: "all-ok", retriedCount: 1 });
  });

  it("handleRetryAllUpload 失败结果：显示错误提示", async () => {
    h.retryAllFailedFiles.mockResolvedValue({
      success: false,
      message: "all-bad",
      retriedCount: 0,
    });
    const { result } = renderHook(() => useFileOperations(makeBatch()));

    await act(async () => {
      await result.current.handleRetryAllUpload();
    });

    expect(h.message.error).toHaveBeenCalledWith("all-bad");
  });
});
