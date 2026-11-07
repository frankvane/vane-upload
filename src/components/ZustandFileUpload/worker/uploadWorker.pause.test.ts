import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Worker 级 暂停/恢复 + 字节级进度 集成测试（T3.3 / T3.4）：
 * 直接加载 uploadWorker 模块（注册 self.onmessage），mock fetch 后：
 *  - 断言 pause 在分片边界挂起并回 paused（含 uploadedChunks/totalChunks）
 *  - 断言 resume 解除挂起后从断点续传直至 done（字节级进度详情随每次分片回传）
 */

const postedMessages: Array<Record<string, unknown>> = [];

let hangUpload = false; // true：分片上传请求挂起（不 resolve），用于确定性暂停
let uploadResolveDelayMs = 0; // 分片上传 resolve 前的延迟，用于制造续传窗口

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const fetchMock = vi.fn(async (url: string) => {
  if (String(url).includes("/instant")) {
    // 非秒传：返回全部分片需上传
    return jsonResponse({
      code: 200,
      data: {
        uploaded: false,
        chunkCheckResult: [], // 空数组 → 上传所有分片
      },
    });
  }
  if (String(url).includes("/merge")) {
    return jsonResponse({ code: 200 });
  }
  if (String(url).includes("/upload")) {
    if (hangUpload) {
      // 挂起：模拟长时间在途请求，便于验证暂停能停止后续分片
      return new Promise<Response>(() => undefined);
    }
    if (uploadResolveDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, uploadResolveDelayMs));
    }
    return new Response("ok", { status: 200 });
  }
  return jsonResponse({ code: 200 });
});

const dispatch = (data: unknown) => {
  const handler = (self as unknown as { onmessage: (e: MessageEvent) => void })
    .onmessage;
  return handler({ data } as MessageEvent);
};

const waitForMessage = (
  predicate: (m: Record<string, unknown>) => boolean,
  timeoutMs = 2000
) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const found = postedMessages.find(predicate);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("等待 worker 消息超时"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });

describe("uploadWorker 暂停 / 恢复（T3.3）", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    postedMessages.length = 0;
    hangUpload = false;
    uploadResolveDelayMs = 0;
    (self as unknown as { postMessage: unknown }).postMessage = (message: {
      type: string;
    }) => {
      postedMessages.push(message);
    };
    await import("./uploadWorker");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("暂停时挂起在分片边界并回 paused（含已传分片数与总分片数），不再发起新上传", async () => {
    hangUpload = true; // 分片请求挂起，制造“在途”状态
    const fileSize = 3 * 1024; // 3 个分片
    const fileRef = new File([new Uint8Array(fileSize).fill(7)], "pause.bin");

    void dispatch({
      type: "upload",
      fileInfo: {
        id: "pause-case-1",
        fileName: "pause.bin",
        fileSize,
        hash: "0".repeat(32),
        chunkSize: 1024,
        chunkKey: `${"0".repeat(32)}_${fileSize}_1024`,
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

    // 等待秒传确认后首个分片请求发起
    await vi.waitFor(() => {
      const uploadCalls = fetchMock.mock.calls.filter(([u]) =>
        String(u).includes("/upload")
      );
      expect(uploadCalls.length).toBeGreaterThan(0);
    });

    // 发送暂停
    await dispatch({ type: "pause", fileId: "pause-case-1" });

    const pausedMsg = (await waitForMessage(
      (m) => m.type === "paused" && m.fileId === "pause-case-1"
    )) as { uploadedChunks: number; totalChunks: number };

    expect(pausedMsg.totalChunks).toBe(3);
    expect(pausedMsg.uploadedChunks).toBe(0); // 唯一在途分片尚未完成
    expect(postedMessages.some((m) => m.type === "done")).toBe(false);

    // 等待足够久，确认暂停后没有新的分片请求发起（边界挂起生效）
    await new Promise((resolve) => setTimeout(resolve, 120));
    const uploadCallsAfterPause = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("/upload")
    );
    expect(uploadCallsAfterPause.length).toBe(1);
  });

  it("暂停后继续（resume）从断点续传至完成，并回传字节级进度详情", async () => {
    uploadResolveDelayMs = 30; // 每个分片 30ms，制造续传窗口
    const fileSize = 3 * 1024;
    const fileRef = new File([new Uint8Array(fileSize).fill(3)], "resume.bin");

    void dispatch({
      type: "upload",
      fileInfo: {
        id: "resume-case-1",
        fileName: "resume.bin",
        fileSize,
        hash: "1".repeat(32),
        chunkSize: 1024,
        chunkKey: `${"1".repeat(32)}_${fileSize}_1024`,
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

    // 等待首个分片进度回传（progress 消息不含 fileId，仅按 type 匹配）
    await waitForMessage((m) => m.type === "progress");

    // 暂停
    await dispatch({ type: "pause", fileId: "resume-case-1" });
    expect(
      postedMessages.some(
        (m) => m.type === "paused" && m.fileId === "resume-case-1"
      )
    ).toBe(true);

    // 继续
    await dispatch({ type: "resume", fileId: "resume-case-1" });

    // 应最终完成
    await waitForMessage((m) => m.type === "done");
    expect(postedMessages.some((m) => m.type === "done")).toBe(true);

    // 全部 3 个分片均已（重新）上传
    const uploadCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("/upload")
    );
    expect(uploadCalls.length).toBe(3);

    // 字节级进度详情：至少一条 progress 携带完整字段且语义正确
    const progressMsgs = postedMessages.filter(
      (m) => m.type === "progress"
    ) as Array<{
      progress: number;
      uploadedBytes: number;
      totalBytes: number;
      speed: number;
      eta: number;
    }>;
    expect(progressMsgs.length).toBeGreaterThan(0);
    const last = progressMsgs[progressMsgs.length - 1]!;
    expect(last.totalBytes).toBe(fileSize);
    expect(last.uploadedBytes).toBeGreaterThan(0);
    expect(last.uploadedBytes).toBeLessThanOrEqual(fileSize);
    expect(last.progress).toBeGreaterThan(0);
    expect(last.progress).toBeLessThanOrEqual(100);
    expect(typeof last.speed).toBe("number");
    expect(typeof last.eta).toBe("number");
  });
});
