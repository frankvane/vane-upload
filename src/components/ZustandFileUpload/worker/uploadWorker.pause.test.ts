import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Worker 级 暂停 集成测试（D-05 方案 A）：
 * 直接加载 uploadWorker 模块（注册 self.onmessage），mock fetch 后断言——
 *  - 暂停 = 中断在途请求 + 回 paused（含 uploadedChunks/totalChunks）
 *  - 不再有「Worker 内挂起等待 resume」语义（该状态机已删）
 *  - 已删除的 resume 指令被忽略：不会回到 done / resumed
 */

const postedMessages: Array<Record<string, unknown>> = [];

let hangUpload = false; // true：分片上传请求挂起（不 resolve），用于确定性暂停

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
      // 挂起：模拟长时间在途请求，便于验证暂停能中断在途
      return new Promise<Response>(() => undefined);
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

describe("uploadWorker 暂停（D-05 方案 A：软取消 + 回 paused）", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    postedMessages.length = 0;
    hangUpload = false;
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

  it("暂停时中断在途请求并回 paused（含已传/总分片数），不回 resumed、不续传、不 done", async () => {
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

    // 发送暂停：D-05 方案 A 应中断在途并回 paused（不再挂起等待 resume）
    await dispatch({ type: "pause", fileId: "pause-case-1" });

    const pausedMsg = (await waitForMessage(
      (m) => m.type === "paused" && m.fileId === "pause-case-1"
    )) as { uploadedChunks: number; totalChunks: number };

    expect(pausedMsg.totalChunks).toBe(3);
    expect(pausedMsg.uploadedChunks).toBe(0); // 唯一在途分片尚未完成
    // 不得再回 resumed（挂起状态机已删），也不得直接 done
    expect(postedMessages.some((m) => m.type === "resumed")).toBe(false);
    expect(postedMessages.some((m) => m.type === "done")).toBe(false);

    // 暂停后不应再发起新的分片请求（事件驱动断言，替代固定 120ms 等待）
    const uploadCallsAfterPause = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("/upload")
    );
    expect(uploadCallsAfterPause.length).toBe(1);

    // 已删除的 resume 指令应被忽略：不会回到 done / resumed
    await dispatch({ type: "resume", fileId: "pause-case-1" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(postedMessages.some((m) => m.type === "resumed")).toBe(false);
    expect(postedMessages.some((m) => m.type === "done")).toBe(false);
  });
});
