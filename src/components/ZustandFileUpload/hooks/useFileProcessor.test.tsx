import React from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ChangeEvent } from "react";

import { useFileProcessor } from "./useFileProcessor";

/**
 * VU-58 收尾：为 useFileProcessor 编写行为断言单测。
 * 被测模块依赖 worker bridge、zustand store、upload engine、config、dedupe 等重依赖，
 * 全部以 vi.mock 拦截，只验证 useFileProcessor 自身逻辑：
 *  1) maxFiles 累计上限（已存在 + 本次选择 超过上限）
 *  2) maxFileSize 超限拦截
 *  3) MIME 白名单拦截
 *  4) 离线（navigator.onLine=false / isNetworkOffline）早退
 *  5) 基于文件 id 的计时键（而非文件名）
 */

const h = vi.hoisted(() => {
  const messageApi = {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  };
  const storeState = {
    existingFiles: [] as Array<{ id: string }>,
    isNetworkOffline: false,
    networkType: "wifi",
    fileConcurrency: 2,
    chunkConcurrency: 2,
    chunkSize: 1024 * 1024,
    refreshFiles: vi.fn(() => Promise.resolve()),
    setProcessProgress: vi.fn(),
    setLoading: vi.fn(),
    setCost: vi.fn(),
    setFileTimings: vi.fn(),
    getMessageApi: () => messageApi,
  };
  const config = {
    maxFiles: 100,
    maxFileSize: 100 * 1024 * 1024,
    allowedFileTypes: [] as string[],
    autoUpload: false,
    hashMode: "full" as const,
  };
  const engine = {
    instanceId: "default",
    storage: { setItem: vi.fn(() => Promise.resolve()) },
    fileRegistry: { registerFileRef: vi.fn() },
    workerPool: { dispose: vi.fn() },
    store: { getState: () => ({ files: [] as Array<{ id: string }> }) },
  };
  const instances: Array<{
    onmessage: ((e: MessageEvent) => void) | null;
    onerror: ((e: unknown) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }> = [];
  class MockWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    postMessage = vi.fn();
    terminate = vi.fn();
    constructor() {
      instances.push(this);
    }
  }
  return { messageApi, storeState, config, engine, instances, MockWorker };
});

vi.mock("../store/upload", () => ({
  useUploadStore: vi.fn(() => h.storeState),
}));

vi.mock("./useEffectiveConfig", () => ({
  useEffectiveUploadConfig: vi.fn(() => h.config),
}));

vi.mock("../context/UploadEngineContext", () => ({
  useUploadEngine: vi.fn(() => h.engine),
}));

vi.mock("../services/uploadDedupe", () => ({
  dedupeByContentKey: vi.fn(() => ({ newItems: [], skipped: 0 })),
}));

vi.mock("../worker/filePrepareWorker.ts?worker", () => ({
  default: h.MockWorker,
}));

const makeEvent = (files: File[]): ChangeEvent<HTMLInputElement> =>
  ({ target: { files, value: "" } } as unknown as ChangeEvent<HTMLInputElement>);

const makeFile = (name: string, type: string, size: number): File =>
  new File([new Uint8Array(size)], name, { type });

beforeEach(() => {
  h.messageApi.error = vi.fn();
  h.messageApi.warning = vi.fn();
  h.messageApi.success = vi.fn();
  h.messageApi.info = vi.fn();

  h.storeState.existingFiles = [];
  h.storeState.isNetworkOffline = false;
  h.storeState.getMessageApi = () => h.messageApi;

  h.config.maxFiles = 100;
  h.config.maxFileSize = 100 * 1024 * 1024;
  h.config.allowedFileTypes = [];
  h.config.autoUpload = false;
  h.config.hashMode = "full";

  h.instances.length = 0;
});

describe("useFileProcessor 行为断言", () => {
  it("P2-3：maxFiles 校验的是「已存在+本次」累计总数，而非单次数量", () => {
    // 已有 9 个文件，上限 10，再选 2 个 → 11 > 10，应被整体拦截
    h.storeState.existingFiles = Array.from({ length: 9 }, (_, i) => ({
      id: `existing-${i}`,
    }));
    h.config.maxFiles = 10;

    const { result } = renderHook(() => useFileProcessor({ uploadAll: vi.fn() }));

    act(() => {
      result.current.handleFileChange(
        makeEvent([makeFile("a.txt", "text/plain", 10), makeFile("b.txt", "text/plain", 10)])
      );
    });

    // 累计超过上限 → 提示中包含上限值与已存在数量
    expect(h.messageApi.error).toHaveBeenCalledWith(
      "最多只能选择 10 个文件（当前已有 9 个）"
    );
    // 全部被拒，不应创建预处理 worker
    expect(h.instances.length).toBe(0);
    expect(h.storeState.setLoading).not.toHaveBeenCalled();
  });

  it("VU-37：单个文件超过 maxFileSize 时拦截并提示，且不进入预处理", () => {
    h.config.maxFileSize = 1024 * 1024; // 1MB
    const oversized = makeFile("big.bin", "application/octet-stream", 2 * 1024 * 1024);

    const { result } = renderHook(() => useFileProcessor({ uploadAll: vi.fn() }));

    act(() => {
      result.current.handleFileChange(makeEvent([oversized]));
    });

    expect(h.messageApi.error).toHaveBeenCalledWith(
      expect.stringContaining("大小超过限制 (1MB)")
    );
    expect(h.instances.length).toBe(0);
  });

  it("MIME 白名单拦截：不在 allowedFileTypes 的文件类型被拒绝", () => {
    h.config.allowedFileTypes = ["image/png"];
    const disallowed = makeFile("doc.txt", "text/plain", 100);

    const { result } = renderHook(() => useFileProcessor({ uploadAll: vi.fn() }));

    act(() => {
      result.current.handleFileChange(makeEvent([disallowed]));
    });

    expect(h.messageApi.error).toHaveBeenCalledWith(
      '文件 "doc.txt" 类型不被允许'
    );
    // 类型被拒 → 不创建预处理 worker
    expect(h.instances.length).toBe(0);
  });

  it("离线早退：isNetworkOffline 时直接提示并 return，不做任何校验/预处理", () => {
    h.storeState.isNetworkOffline = true;
    const valid = makeFile("ok.png", "image/png", 100);

    const { result } = renderHook(() => useFileProcessor({ uploadAll: vi.fn() }));

    act(() => {
      result.current.handleFileChange(makeEvent([valid]));
    });

    // 离线提示文案精确匹配
    expect(h.messageApi.error).toHaveBeenCalledWith("网络已断开，无法上传文件");
    expect(h.messageApi.error).toHaveBeenCalledTimes(1);
    // 早退于校验之前：不应进入 loading / 创建 worker / 触发大小/类型校验
    expect(h.storeState.setLoading).not.toHaveBeenCalled();
    expect(h.instances.length).toBe(0);
  });

  it("VU-17：计时键基于文件 id，而非文件名（同名文件不互相覆盖）", async () => {
    const valid = makeFile("realname.png", "image/png", 100);

    const { result } = renderHook(() => useFileProcessor({ uploadAll: vi.fn() }));

    // 触发同步部分：创建 worker 并挂上 onmessage
    act(() => {
      result.current.handleFileChange(makeEvent([valid]));
    });
    expect(h.instances.length).toBe(1);
    const worker = h.instances[0]!;
    // 断言 worker 被 postMessage 启动，且携带配置化的 hashMode 与网络参数
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [valid],
        hashMode: "full",
        networkParams: expect.objectContaining({
          networkType: "wifi",
          fileConcurrency: 2,
          chunkConcurrency: 2,
          chunkSize: 1024 * 1024,
        }),
      })
    );

    // 推一条 progress 消息，fileDetails.id 与 fileName 故意不同
    act(() => {
      worker.onmessage!({
        data: {
          type: "progress",
          processed: 1,
          total: 1,
          success: 1,
          failed: 0,
          oversized: 0,
          fileDetails: {
            id: "file-id-xyz",
            fileName: "realname.png",
            fileSize: 100,
            fileType: "image/png",
            index: 0,
            total: 1,
          },
        },
      } as MessageEvent);
    });

    // 推 complete 消息让 Promise settle（newItems=[] → 直接 resolve）
    await act(async () => {
      worker.onmessage!({
        data: {
          type: "complete",
          uploadFiles: [],
          stats: { processed: 1, total: 1, success: 1, failed: 0, oversized: 0 },
        },
      } as MessageEvent);
    });

    // 找到以函数式 updater 形式写入的 setFileTimings 调用
    const timingCalls = h.storeState.setFileTimings.mock.calls;
    const updaterCall = timingCalls.find((c) => typeof c[0] === "function");
    expect(updaterCall).toBeTruthy();

    const applied = (updaterCall![0] as (prev: Record<string, number>) => Record<string, number>)({});
    // 计时键必须是文件 id
    expect(applied).toHaveProperty("file-id-xyz");
    // 且不是文件名（防止同名文件互相覆盖）
    expect(applied).not.toHaveProperty("realname.png");

    // 预处理流程收尾：loading 置回 false、记录耗时
    expect(h.storeState.setLoading).toHaveBeenCalledWith(false);
    expect(h.storeState.setCost).toHaveBeenCalled();
  });
});
