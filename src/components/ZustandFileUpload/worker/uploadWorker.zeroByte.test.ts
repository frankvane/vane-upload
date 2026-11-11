import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-74 Worker 协议边界：
 *  1) 0 字节文件不产生任何分片，服务端 /merge 不接受 total=0 ——
 *     必须发一次 100% progress 后直接 done，且不发起任何请求。
 *  2) 缺少 fileInfo 的异常日志不得把整个 event.data（含 authHeaders / fileRef）
 *     写进出站 debug。
 */

const postedMessages: Array<{ type: string; [key: string]: unknown }> = [];
const requestedUrls: string[] = [];

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const fetchMock = vi.fn(async (url: string) => {
  requestedUrls.push(String(url));
  return jsonResponse({ code: 200, data: { uploaded: false } });
});

const dispatch = (data: unknown) => {
  const handler = (self as unknown as { onmessage: (e: MessageEvent) => void })
    .onmessage;
  return handler({ data } as MessageEvent);
};

describe("T-74 Worker 0 字节与异常日志边界", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    requestedUrls.length = 0;
    postedMessages.length = 0;
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

  it("0 字节文件发一次 100% progress 且直接 done，不发 total:0 的 merge", async () => {
    await dispatch({
      type: "upload",
      fileInfo: {
        id: "zero-1",
        fileName: "zero.bin",
        fileSize: 0,
        hash: "0".repeat(32),
        chunkSize: 1024,
        chunkKey: "zero-key",
      },
      fileRef: new File([], "zero.bin"),
      networkParams: { chunkConcurrency: 1 },
      uploadConfig: {
        baseURL: "",
        uploadApi: "/api/file/upload",
        checkApi: "/api/file/instant",
        mergeApi: "/api/file/merge",
        debug: true,
      },
    });

    const progress = postedMessages.filter((m) => m.type === "progress");
    expect(progress).toHaveLength(1);
    expect(progress[0]!.progress).toBe(100);
    expect(postedMessages.some((m) => m.type === "done")).toBe(true);
    expect(requestedUrls.some((url) => url.includes("/merge"))).toBe(false);
    // 连预检 / 状态查询都不该发：0 字节没有分片，也没有合并动作
    expect(requestedUrls).toHaveLength(0);
  });

  it("缺少 fileInfo 时异常 debug 只带 type，authHeaders 不进日志", async () => {
    await dispatch({
      type: "upload",
      fileInfo: undefined,
      fileRef: new File([new Uint8Array(10)], "x.bin"),
      uploadConfig: {
        debug: true,
        authHeaders: { authorization: "Bearer leak-secret" },
      },
    });

    const debugMessages = postedMessages.filter((m) => m.type === "debug");
    const missing = debugMessages.find((m) => m.message === "缺少文件信息");
    expect(missing).toBeTruthy();
    expect(missing!.data).toEqual({ type: "upload" });
    expect(JSON.stringify(debugMessages)).not.toContain("leak-secret");
    expect(postedMessages.some((m) => m.type === "error")).toBe(true);
  });
});
