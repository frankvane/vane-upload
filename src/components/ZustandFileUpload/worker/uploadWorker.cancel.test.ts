import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Worker 级 CANCEL 协议测试（T2.3 / P1-8）：
 * 直接加载 uploadWorker 模块（副作用：注册 self.onmessage），
 * mock fetch 后在上传途中发送 CANCEL，断言在途请求的 signal 被中断。
 */

const postedMessages: Array<{ type: string; [key: string]: unknown }> = [];
const capturedSignals: Array<AbortSignal | undefined | null> = [];

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const fetchMock = vi.fn(async (url: string, options: RequestInit = {}) => {
  capturedSignals.push(options.signal);

  if (String(url).includes("/instant")) {
    return jsonResponse({
      code: 200,
      data: {
        uploaded: false,
        chunkCheckResult: [{ index: 0, exist: false, match: false }],
      },
    });
  }
  if (String(url).includes("/status")) {
    // P2-1：续传查询没有已存在分片
    return jsonResponse({ code: 200, data: { chunks: [] } });
  }
  if (String(url).includes("/merge")) {
    return jsonResponse({ code: 200 });
  }

  // 分片上传：挂起直到被取消，模拟在途请求
  return new Promise<Response>((_resolve, reject) => {
    if (options.signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }
    options.signal?.addEventListener(
      "abort",
      () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      },
      { once: true }
    );
  });
});

const dispatch = (data: unknown) => {
  const handler = (self as unknown as { onmessage: (e: MessageEvent) => void })
    .onmessage;
  return handler({ data } as MessageEvent);
};

describe("uploadWorker CANCEL 协议（T2.3）", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    capturedSignals.length = 0;
    postedMessages.length = 0;
    (self as unknown as { postMessage: unknown }).postMessage = (message: {
      type: string;
    }) => {
      postedMessages.push(message);
    };
    // 加载 worker 模块（注册 self.onmessage）
    await import("./uploadWorker");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("上传途中收到 CANCEL：在途 fetch 的 signal 被中断，并回 cancelled 确认", async () => {
    const fileRef = new File([new Uint8Array(1024).fill(7)], "cancel.bin");

    const uploadPromise = dispatch({
      type: "upload",
      fileInfo: {
        id: "cancel-case-1",
        fileName: "cancel.bin",
        fileSize: 1024,
        hash: "0".repeat(32),
        chunkSize: 1024,
        chunkKey: `${"0".repeat(32)}_1024_1024`,
      },
      fileRef,
      networkParams: { chunkConcurrency: 1, maxRetries: 1 },
      uploadConfig: {
        baseURL: "",
        uploadApi: "/api/file/upload",
        checkApi: "/api/file/instant",
        mergeApi: "/api/file/merge",
      },
    });

    // 等待秒传完成、分片 fetch 发起
    await vi.waitFor(() => {
      const uploadCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/upload")
      );
      expect(uploadCalls.length).toBeGreaterThan(0);
    });

    const inFlightSignal = capturedSignals[capturedSignals.length - 1];
    expect(inFlightSignal?.aborted).toBeFalsy();

    // 发送 CANCEL
    await dispatch({ type: "cancel", fileId: "cancel-case-1" });

    expect(inFlightSignal?.aborted).toBe(true);
    expect(
      postedMessages.some((m) => m.type === "cancelled" && m.fileId === "cancel-case-1")
    ).toBe(true);

    // worker 主流程收敛：不再发起新的上传请求，最终不报 done
    await uploadPromise;
    const uploadCallsAfter = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/upload")
    );
    expect(uploadCallsAfter.length).toBe(1);
    expect(postedMessages.some((m) => m.type === "done")).toBe(false);
  });

  it("CANCEL 后不再对同一任务发起任何新请求（重试短路）", async () => {
    const fileRef = new File([new Uint8Array(2048).fill(3)], "cancel2.bin");

    const uploadPromise = dispatch({
      type: "upload",
      fileInfo: {
        id: "cancel-case-2",
        fileName: "cancel2.bin",
        fileSize: 2048,
        hash: "1".repeat(32),
        chunkSize: 1024,
        chunkKey: `${"1".repeat(32)}_2048_1024`,
      },
      fileRef,
      networkParams: { chunkConcurrency: 2, maxRetries: 3, retryInterval: 10 },
      uploadConfig: {
        baseURL: "",
        uploadApi: "/api/file/upload",
        checkApi: "/api/file/instant",
        mergeApi: "/api/file/merge",
      },
    });

    await vi.waitFor(() => {
      const uploadCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/upload")
      );
      expect(uploadCalls.length).toBeGreaterThan(0);
    });

    await dispatch({ type: "cancel", fileId: "cancel-case-2" });
    const callsAtCancel = fetchMock.mock.calls.length;

    // 等待足够久（覆盖多个重试间隔），不应有新请求
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fetchMock.mock.calls.length).toBe(callsAtCancel);

    await uploadPromise;
    expect(postedMessages.some((m) => m.type === "done")).toBe(false);
  });
});
