import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-73 ⑤-B：把「取消」注入到上传链路的不同阶段，以及 pause / cancel 连续消息。
 *
 * 既有 cancel.test.ts 只覆盖「取消落在 /upload 阶段」。这里按审查报告 L3-9 / L5-6
 * 补齐：取消落在秒传预检（/instant）在途、落在状态查询（/status）在途，以及
 * 暂停后紧接一条 CANCEL。所有断言都是精确值（恰好 N 条消息 / 恰好 N 次请求 /
 * 具体文案），不使用 toBeGreaterThan(0) 式宽松判定。
 */

type Posted = { type: string; [key: string]: unknown };
const postedMessages: Posted[] = [];
const requestedUrls: string[] = [];

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** 让指定路径挂起直到 signal 被 abort（模拟在途请求）。 */
const hangUntilAbort = (options: RequestInit = {}): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    const signal = options.signal;
    const abortError = () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted) {
      abortError();
      return;
    }
    signal?.addEventListener("abort", abortError, { once: true });
  });

let instantHangs = false;
let statusHangs = false;
let instantNetworkFails = false;
let statusChunks: number[] = [];

const fetchMock = vi.fn(async (url: string, options: RequestInit = {}) => {
  requestedUrls.push(String(url));
  if (String(url).includes("/instant")) {
    if (instantNetworkFails) {
      // 普通连接级失败（非取消）：不应被 T-73 的取消短路误伤
      throw new TypeError("Failed to fetch");
    }
    if (instantHangs) return hangUntilAbort(options);
    return jsonResponse({ code: 200, data: { uploaded: false } });
  }
  if (String(url).includes("/status")) {
    if (statusHangs) return hangUntilAbort(options);
    return jsonResponse({ code: 200, data: { chunks: statusChunks } });
  }
  if (String(url).includes("/merge")) {
    return jsonResponse({ code: 200 });
  }
  return hangUntilAbort(options);
});

const dispatch = (data: unknown) => {
  const handler = (self as unknown as { onmessage: (e: MessageEvent) => void })
    .onmessage;
  return handler({ data } as MessageEvent);
};

const buildUploadMessage = (id: string, fileSize = 1024) => ({
  type: "upload" as const,
  fileInfo: {
    id,
    fileName: `${id}.bin`,
    fileSize,
    hash: "0".repeat(32),
    chunkSize: 1024,
    chunkKey: `${"0".repeat(32)}_${fileSize}_1024`,
  },
  fileRef: new File([new Uint8Array(Math.min(fileSize, 1)).fill(1)], `${id}.bin`),
  networkParams: { chunkConcurrency: 1, maxRetries: 1 },
  uploadConfig: {
    baseURL: "",
    uploadApi: "/api/file/upload",
    checkApi: "/api/file/instant",
    statusApi: "/api/file/status",
    mergeApi: "/api/file/merge",
  },
});

const messagesOf = (type: string): Posted[] =>
  postedMessages.filter((message) => message.type === type);

const urlsOf = (fragment: string): string[] =>
  requestedUrls.filter((url) => url.includes(fragment));

describe("T-73 Worker 分阶段故障注入（精确断言）", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    requestedUrls.length = 0;
    postedMessages.length = 0;
    instantHangs = false;
    statusHangs = false;
    instantNetworkFails = false;
    statusChunks = [];
    (self as unknown as { postMessage: unknown }).postMessage = (
      message: Posted,
    ) => {
      postedMessages.push(message);
    };
    await import("./uploadWorker");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("CANCEL 落在秒传预检(/instant)在途：恰好 1 条 cancelled、0 条 error，且不发 /status 与 /upload", async () => {
    instantHangs = true;
    const id = "cancel-in-precheck";
    const pending = dispatch(buildUploadMessage(id));

    await vi.waitFor(() => expect(urlsOf("/instant")).toHaveLength(1));
    await dispatch({ type: "cancel", fileId: id });
    await pending;

    expect(messagesOf("cancelled")).toHaveLength(1);
    expect(messagesOf("cancelled")[0]!.fileId).toBe(id);
    expect(messagesOf("error")).toHaveLength(0);
    expect(messagesOf("done")).toHaveLength(0);
    // 短路修复：预检阶段取消后不再发 /status，更不进入分片上传
    expect(urlsOf("/status")).toHaveLength(0);
    expect(urlsOf("/upload")).toHaveLength(0);
  });

  it("CANCEL 落在状态查询(/status)在途：恰好 1 条 cancelled、0 条 error，且不进入 /upload", async () => {
    statusHangs = true;
    const id = "cancel-in-status";
    const pending = dispatch(buildUploadMessage(id));

    await vi.waitFor(() => expect(urlsOf("/status")).toHaveLength(1));
    await dispatch({ type: "cancel", fileId: id });
    await pending;

    expect(urlsOf("/instant")).toHaveLength(1);
    expect(messagesOf("cancelled")).toHaveLength(1);
    expect(messagesOf("cancelled")[0]!.fileId).toBe(id);
    expect(messagesOf("error")).toHaveLength(0);
    // 短路修复：/status 取消后不再白跑一轮分片准备
    expect(urlsOf("/upload")).toHaveLength(0);
  });

  it("pause 后紧接 CANCEL：paused 1 条、cancelled 1 条，4 个任务状态全部清空", async () => {
    const { __test_getTaskMapSizes } = await import("./uploadWorker");
    const id = "pause-then-cancel";
    const pending = dispatch(buildUploadMessage(id));

    await vi.waitFor(() => expect(urlsOf("/upload")).toHaveLength(1));
    await dispatch({ type: "pause", fileId: id });
    await pending;

    const paused = messagesOf("paused");
    expect(paused).toHaveLength(1);
    expect(paused[0]!.fileId).toBe(id);
    expect(paused[0]!.totalChunks).toBe(1);
    expect(messagesOf("done")).toHaveLength(0);
    expect(messagesOf("error")).toHaveLength(0);

    // pause 分支在 fileId 赋值前 return，外层 finally 覆盖不到；必须自行清理。
    // 尤其 cancelledNotified 被清空后，后续 CANCEL 才不会被静默吞掉。
    expect(__test_getTaskMapSizes()).toEqual({
      abort: 0,
      hosts: 0,
      stats: 0,
      cancelled: 0,
    });

    // 如实记录既有语义：pause 的软取消会让 pipeline 的 signal.aborted 分支也回
    // 一条 cancelled（主线程以 paused 为准）。这里不修改该协议，只验证后续
    // CANCEL 不会因去重集合残留而被吞掉。
    expect(messagesOf("paused")).toHaveLength(1);
    postedMessages.length = 0;

    await dispatch({ type: "cancel", fileId: id });
    expect(messagesOf("cancelled")).toHaveLength(1);
    expect(messagesOf("cancelled")[0]!.fileId).toBe(id);
    expect(messagesOf("paused")).toHaveLength(0);
    expect(__test_getTaskMapSizes()).toEqual({
      abort: 0,
      hosts: 0,
      stats: 0,
      cancelled: 0,
    });
  });

  it("cancelledNotified 去重集合同样随任务结束清空，同 id 再次上传仍可回 cancelled", async () => {
    const { __test_getTaskMapSizes } = await import("./uploadWorker");
    const id = "reuse-after-cancel";

    const first = dispatch(buildUploadMessage(id));
    await vi.waitFor(() => expect(urlsOf("/upload")).toHaveLength(1));
    await dispatch({ type: "cancel", fileId: id });
    await first;
    expect(messagesOf("cancelled")).toHaveLength(1);
    expect(__test_getTaskMapSizes().cancelled).toBe(0);

    postedMessages.length = 0;
    requestedUrls.length = 0;
    const second = dispatch(buildUploadMessage(id));
    await vi.waitFor(() => expect(urlsOf("/upload")).toHaveLength(1));
    await dispatch({ type: "cancel", fileId: id });
    await second;

    // 若 cancelledNotified 残留，第二次取消确认会被静默吞掉 → 这里会变 0
    expect(messagesOf("cancelled")).toHaveLength(1);
    expect(__test_getTaskMapSizes()).toEqual({
      abort: 0,
      hosts: 0,
      stats: 0,
      cancelled: 0,
    });
  });

  it("非取消类预检失败仍继续 /status 并正常收尾（短路不误伤常规降级）", async () => {
    // 预检抛普通 TypeError（非 AbortError）；/status 返回全部分片已存在，
    // 于是不发 /upload，直接 merge → done。全部为精确次数断言。
    instantNetworkFails = true;
    statusChunks = [0];

    await dispatch(buildUploadMessage("precheck-network-fail", 1024));

    expect(urlsOf("/instant")).toHaveLength(1);
    expect(urlsOf("/status")).toHaveLength(1);
    expect(urlsOf("/upload")).toHaveLength(0);
    expect(urlsOf("/merge")).toHaveLength(1);
    expect(messagesOf("cancelled")).toHaveLength(0);
    expect(messagesOf("error")).toHaveLength(0);
    expect(messagesOf("done")).toHaveLength(1);
  });
});
