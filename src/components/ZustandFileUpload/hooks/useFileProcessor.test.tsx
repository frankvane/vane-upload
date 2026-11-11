import React from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ChangeEvent } from "react";

import { useFileProcessor } from "./useFileProcessor";
import { reconcileIncomingFiles } from "../services/uploadDedupe";
import { UploadStatus, type UploadFile } from "../types/upload";

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
    autoUploadDelay: 120 as number | undefined,
  };
  const engine = {
    instanceId: "default",
    storage: { setItem: vi.fn((_key: string, _value: unknown) => Promise.resolve()) },
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
  reconcileIncomingFiles: vi.fn(() => ({
    newItems: [],
    rebindItems: [],
    skipped: 0,
  })),
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
  h.config.autoUploadDelay = 120;

  h.instances.length = 0;
  h.engine.storage.setItem.mockClear();
  h.engine.fileRegistry.registerFileRef.mockClear();
  h.storeState.refreshFiles.mockClear();
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

  it("D-01：0 字节文件在选择阶段即被拒绝（服务端 /merge 不接受 total=0）", () => {
    const empty = makeFile("empty.bin", "application/octet-stream", 0);
    const valid = makeFile("ok.bin", "application/octet-stream", 100);

    const { result } = renderHook(() => useFileProcessor({ uploadAll: vi.fn() }));

    act(() => {
      result.current.handleFileChange(makeEvent([empty, valid]));
    });

    expect(h.messageApi.error).toHaveBeenCalledWith(
      '文件 "empty.bin" 为空文件，不支持上传'
    );
    // 空文件被拒不影响同批合法文件入队
    expect(h.instances.length).toBe(1);
  });

  it("E2E-R2：危险扩展名/危险 MIME 在选择阶段即被拦截并给出可读原因", () => {
    // 即使白名单显式放行该 MIME，危险扩展名仍必须被拒（与服务端 /merge 同口径）
    h.config.allowedFileTypes = ["application/octet-stream"];
    const exe = makeFile("virus.exe", "application/octet-stream", 100);
    const htmlMime = makeFile("page.txt", "text/html", 100);
    const valid = makeFile("ok.bin", "application/octet-stream", 100);

    const { result } = renderHook(() => useFileProcessor({ uploadAll: vi.fn() }));

    act(() => {
      result.current.handleFileChange(makeEvent([exe, htmlMime, valid]));
    });

    expect(h.messageApi.error).toHaveBeenCalledWith(
      '文件 "virus.exe" 不允许上传的类型（危险扩展名 .exe）'
    );
    expect(h.messageApi.error).toHaveBeenCalledWith(
      '文件 "page.txt" 不允许上传的类型（危险内容类型 text/html）'
    );
    // 合法文件照常进入预处理，不因同批危险文件被整体拒绝
    expect(h.instances.length).toBe(1);
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
        // T-18：预处理 Worker 只读 chunkSize，其余网络参数不再白传。
        networkParams: { chunkSize: 1024 * 1024 },
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

  it("T-29：埋点开启时按阶段产出 mark，关闭时一个都不产出", async () => {
    const host = globalThis as unknown as Record<string, unknown>;
    const vaneMarks = () =>
      performance
        .getEntriesByType("mark")
        .map((entry) => entry.name)
        .filter((name) => name.startsWith("vane:"));

    const driveOnce = async (uploadAll: () => Promise<boolean>) => {
      const valid = makeFile("trace.png", "image/png", 100);
      // 命中「新文件入队」分支，才能走到持久化 → queue:persisted
      vi.mocked(reconcileIncomingFiles).mockReturnValueOnce({
        newItems: [
          {
            id: "trace-id",
            fileName: "trace.png",
            fileSize: 100,
            fileType: "image/png",
            lastModified: 0,
            hash: "h-trace",
            hashMode: "full",
            chunkSize: 1024,
            chunkCount: 1,
            status: UploadStatus.QUEUED,
            progress: 0,
            createdAt: 1,
            order: 0,
          } as UploadFile,
        ],
        rebindItems: [],
        skipped: 0,
      });
      const { result } = renderHook(() => useFileProcessor({ uploadAll }));
      act(() => {
        result.current.handleFileChange(makeEvent([valid]));
      });
      const worker = h.instances[h.instances.length - 1]!;
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
              id: "trace-id",
              fileName: "trace.png",
              fileSize: 100,
              fileType: "image/png",
              index: 1,
              total: 1,
            },
          },
        } as MessageEvent);
      });
      await act(async () => {
        worker.onmessage!({
          data: {
            type: "complete",
            uploadFiles: [],
            stats: { processed: 1, total: 1, success: 1, failed: 0, oversized: 0 },
            timings: { boot: 12, waitForMessage: 1, hash: 3 },
          },
        } as MessageEvent);
      });
    };

    // 关闭态（默认）：不能污染业务 timeline
    performance.clearMarks();
    host.__VANE_PERF_TRACE__ = false;
    await driveOnce(vi.fn());
    expect(vaneMarks()).toEqual([]);
    expect(host.__VANE_PERF_TRACE_DETAILS__).toBeUndefined();

    // 开启态：整条链路的关键阶段都要有点，且 Worker 内部耗时进明细包
    performance.clearMarks();
    host.__VANE_PERF_TRACE__ = true;
    let enabledMarks: string[] = [];
    let enabledDetails: unknown;
    try {
      await driveOnce(vi.fn());
      enabledMarks = vaneMarks();
      enabledDetails = host.__VANE_PERF_TRACE_DETAILS__;
    } finally {
      host.__VANE_PERF_TRACE__ = false;
      delete host.__VANE_PERF_TRACE_DETAILS__;
      performance.clearMarks();
    }

    expect(enabledMarks).toEqual(
      expect.arrayContaining([
        "vane:change:enter",
        "vane:change:validated",
        "vane:prepare:worker-created",
        "vane:prepare:first-progress",
        "vane:prepare:complete",
        "vane:queue:persisted",
      ])
    );
    expect(enabledDetails).toEqual({
      prepareWorker: { boot: 12, waitForMessage: 1, hash: 3 },
    });
  });

  it("E2E-02：重选同一文件时复用既有 id 与 chunkSize，保证分片键稳定", async () => {
    const fileRef = new File(["abc"], "a.bin");
    const existing: UploadFile = {
      id: "q-old",
      fileName: "a.bin",
      fileSize: 100,
      fileType: "",
      lastModified: 0,
      hash: "h1",
      hashMode: "full",
      chunkSize: 256 * 1024,
      chunkCount: 1,
      status: UploadStatus.ERROR,
      progress: 0,
      createdAt: 1,
      order: 0,
      errorMessage: "文件引用已失效",
      awaitingReselect: false,
    };
    const incoming: UploadFile = {
      ...existing,
      id: "q-new",
      chunkSize: 1024 * 1024,
      chunkCount: 1,
      status: UploadStatus.QUEUED,
      createdAt: 2,
      fileRef,
    };
    vi.mocked(reconcileIncomingFiles).mockReturnValueOnce({
      newItems: [],
      rebindItems: [{ existing, incoming }],
      skipped: 0,
    });

    const { result } = renderHook(() =>
      useFileProcessor({ uploadAll: vi.fn() })
    );

    act(() => {
      result.current.handleFileChange(makeEvent([makeFile("a.bin", "", 100)]));
    });

    const worker = h.instances[0]!;
    await act(async () => {
      worker.onmessage!({
        data: {
          type: "complete",
          uploadFiles: [incoming],
          stats: { processed: 1, total: 1, success: 1, failed: 0, oversized: 0 },
        },
      } as MessageEvent);
    });

    expect(h.engine.fileRegistry.registerFileRef).toHaveBeenCalledWith(
      "q-old",
      fileRef
    );
    const write = h.engine.storage.setItem.mock.calls.find(
      ([id]) => id === "q-old"
    );
    expect(write).toBeTruthy();
    expect(write![1]).toMatchObject({
      id: "q-old",
      chunkSize: 256 * 1024,
      chunkCount: 1,
      status: UploadStatus.QUEUED,
      errorMessage: undefined,
      awaitingReselect: undefined,
    });
    expect((write![1] as UploadFile).fileRef).toBeUndefined();
    expect(h.messageApi.info).toHaveBeenCalledWith(
      expect.stringContaining("断点继续上传")
    );
    expect(h.storeState.refreshFiles).toHaveBeenCalled();
  });
});

describe("T-30 自动上传合并窗口（autoUploadDelay）", () => {
  /** 造一份「新文件入队」的 dedupe 结果，让链路能走到持久化与定时器 */
  const queueNewFile = (id: string) => {
    vi.mocked(reconcileIncomingFiles).mockReturnValueOnce({
      newItems: [
        {
          id,
          fileName: `${id}.png`,
          fileSize: 100,
          fileType: "image/png",
          lastModified: 0,
          hash: `h-${id}`,
          hashMode: "full",
          chunkSize: 1024,
          chunkCount: 1,
          status: UploadStatus.QUEUED,
          progress: 0,
          createdAt: 1,
          order: 0,
        } as UploadFile,
      ],
      rebindItems: [],
      skipped: 0,
    });
  };

  /** 选一次文件并把预处理 Worker 的 complete 回灌，等价于「选完 + 预处理完成」 */
  const selectAndComplete = async (result: {
    current: { handleFileChange: (e: ChangeEvent<HTMLInputElement>) => void };
  }) => {
    act(() => {
      result.current.handleFileChange(makeEvent([makeFile("x.png", "image/png", 100)]));
    });
    const worker = h.instances[h.instances.length - 1]!;
    await act(async () => {
      worker.onmessage!({
        data: {
          type: "complete",
          uploadFiles: [],
          stats: { processed: 1, total: 1, success: 1, failed: 0, oversized: 0 },
        },
      } as MessageEvent);
    });
  };

  it("默认 120ms：窗口内的第二次选择被合并为一批，只开跑一次", async () => {
    vi.useFakeTimers();
    try {
      h.config.autoUpload = true;
      h.config.autoUploadDelay = undefined; // 走默认值
      const uploadAll = vi.fn(async () => true);
      const { result } = renderHook(() => useFileProcessor({ uploadAll }));

      queueNewFile("t30-a");
      await selectAndComplete(result);

      // 距第一次选择 100ms —— 未到默认窗口
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(uploadAll).not.toHaveBeenCalled();

      // 窗口内再选一次：定时器被重置（旧实现 500ms 也是这个语义，这里锁住「合并」行为）
      queueNewFile("t30-b");
      await selectAndComplete(result);
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(uploadAll).not.toHaveBeenCalled();

      // 从第二次选择算起再过 20ms 才到点，且整批只开跑一次
      await act(async () => {
        vi.advanceTimersByTime(20);
      });
      expect(uploadAll).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("autoUploadDelay=0：两次选择各自开跑（退化为「不合并」）", async () => {
    vi.useFakeTimers();
    try {
      h.config.autoUpload = true;
      h.config.autoUploadDelay = 0;
      const uploadAll = vi.fn(async () => true);
      const { result } = renderHook(() => useFileProcessor({ uploadAll }));

      queueNewFile("t30-c");
      await selectAndComplete(result);
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      queueNewFile("t30-d");
      await selectAndComplete(result);
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      expect(uploadAll).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["Infinity", Number.POSITIVE_INFINITY],
    ["负数", -5],
    ["NaN", Number.NaN],
  ])("脏值 %s 回落默认窗口，不会「永不触发」也不会「立即触发」", async (_label, dirty) => {
    vi.useFakeTimers();
    try {
      h.config.autoUpload = true;
      h.config.autoUploadDelay = dirty as number;
      const uploadAll = vi.fn(async () => true);
      const { result } = renderHook(() => useFileProcessor({ uploadAll }));

      queueNewFile("t30-e");
      await selectAndComplete(result);

      // 未到默认 120ms 之前不该开跑（Infinity 的旧行为是永远不开跑，这里必须能到点）
      await act(async () => {
        vi.advanceTimersByTime(119);
      });
      expect(uploadAll).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(uploadAll).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("autoUpload=false 时窗口完全不参与（不会定时开跑）", async () => {
    vi.useFakeTimers();
    try {
      h.config.autoUpload = false;
      h.config.autoUploadDelay = 120;
      const uploadAll = vi.fn(async () => true);
      const { result } = renderHook(() => useFileProcessor({ uploadAll }));

      queueNewFile("t30-f");
      await selectAndComplete(result);
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });

      expect(uploadAll).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("T-34 预处理生命周期（重入 / 卸载 / StrictMode）", () => {
  const completeData = {
    type: "complete",
    uploadFiles: [],
    stats: { processed: 1, total: 1, success: 1, failed: 0, oversized: 0 },
  };

  const queueOne = (id: string) => {
    vi.mocked(reconcileIncomingFiles).mockReturnValueOnce({
      newItems: [
        {
          id,
          fileName: `${id}.png`,
          fileSize: 100,
          fileType: "image/png",
          lastModified: 0,
          hash: `h-${id}`,
          hashMode: "full",
          chunkSize: 1024,
          chunkCount: 1,
          status: UploadStatus.QUEUED,
          progress: 0,
          createdAt: 1,
          order: 0,
        } as UploadFile,
      ],
      rebindItems: [],
      skipped: 0,
    });
  };

  const select = (result: {
    current: { handleFileChange: (e: ChangeEvent<HTMLInputElement>) => void };
  }) => {
    act(() => {
      result.current.handleFileChange(
        makeEvent([makeFile("x.png", "image/png", 100)])
      );
    });
  };

  it("重入：第二次选择 abort 第一次的预处理 Promise 并解绑旧 Worker", async () => {
    const { result } = renderHook(() =>
      useFileProcessor({ uploadAll: vi.fn(async () => true) })
    );

    await act(async () => {
      select(result);
      const first = h.instances[0]!;
      select(result);
      // 让旧 Promise 的 reject → catch → finally 走完
      await Promise.resolve();
      await Promise.resolve();
      expect(first.onmessage).toBeNull();
    });
    expect(h.instances).toHaveLength(2);
    expect(h.messageApi.error).not.toHaveBeenCalled();
  });

  it("卸载后从 await 恢复的预处理结果不得写回、提示或调度自动上传", async () => {
    vi.useFakeTimers();
    try {
      h.config.autoUpload = true;
      h.config.autoUploadDelay = 120;
      queueOne("unmount-a");
      const uploadAll = vi.fn(async () => true);
      let releaseWrite: () => void = () => undefined;
      h.engine.storage.setItem.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseWrite = resolve;
          })
      );

      const { result, unmount } = renderHook(() =>
        useFileProcessor({ uploadAll })
      );
      select(result);
      const worker = h.instances[0]!;
      await act(async () => {
        worker.onmessage!({ data: completeData } as MessageEvent);
      });
      unmount();

      await act(async () => {
        releaseWrite();
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(uploadAll).not.toHaveBeenCalled();
      expect(h.storeState.refreshFiles).not.toHaveBeenCalled();
      expect(h.messageApi.success).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("StrictMode 双挂载后 disposed 标记复位，错误提示不被吞", async () => {
    const { result } = renderHook(
      () => useFileProcessor({ uploadAll: vi.fn(async () => true) }),
      { wrapper: React.StrictMode }
    );

    select(result);
    const worker = h.instances[h.instances.length - 1]!;
    await act(async () => {
      worker.onerror?.({ message: "预处理失败" } as unknown as ErrorEvent);
    });

    expect(h.messageApi.error).toHaveBeenCalled();
  });
});
