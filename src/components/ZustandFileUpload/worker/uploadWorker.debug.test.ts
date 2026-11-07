import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 调试日志开关与节流测试（T2.4 / P1-10）。
 * 复用 uploadWorker.cancel.test.ts 的加载方式：真实 worker 模块 + fetch mock。
 */

const postedMessages: Array<{ type: string; [key: string]: unknown }> = [];
let consoleLogCalls = 0;

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const fetchMock = vi.fn(async (url: string) => {
  if (String(url).includes("/instant")) {
    return jsonResponse({
      code: 200,
      data: {
        uploaded: false,
        chunkCheckResult: Array.from({ length: 1000 }, (_, i) => ({
          index: i,
          exist: false,
          match: false,
        })),
      },
    });
  }
  if (String(url).includes("/merge")) {
    return jsonResponse({ code: 200 });
  }
  // 首个分片返回 500（maxRetries=1 不再重试）→ 触发紧急失败日志
  const uploadCount = fetchMock.mock.calls.filter(([u]) =>
    String(u).includes("/upload")
  ).length;
  if (uploadCount === 1) {
    return jsonResponse({ message: "boom" }, 500);
  }
  return jsonResponse({ code: 200 });
});

const dispatch = (data: unknown) => {
  const handler = (self as unknown as { onmessage: (e: MessageEvent) => void })
    .onmessage;
  return handler({ data } as MessageEvent);
};

const runUpload = async (debug: boolean) => {
  // 1000 字节、1 字节/片 → 1000 个分片，制造高频分片级日志
  const fileRef = new File([new Uint8Array(1000).fill(9)], "debug.bin");

  await dispatch({
    type: "upload",
    fileInfo: {
      id: `debug-case-${debug ? "on" : "off"}`,
      fileName: "debug.bin",
      fileSize: 1000,
      hash: "a".repeat(32),
      chunkSize: 1,
        chunkKey: `${"a".repeat(32)}_1000_1`,
    },
    fileRef,
    networkParams: { chunkConcurrency: 8, maxRetries: 1 },
    uploadConfig: {
      baseURL: "",
      uploadApi: "/api/file/upload",
      checkApi: "/api/file/instant",
      mergeApi: "/api/file/merge",
      debug,
    },
  });
};

describe("uploadWorker 调试日志开关（T2.4）", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    postedMessages.length = 0;
    consoleLogCalls = 0;
    vi.spyOn(console, "log").mockImplementation(() => {
      consoleLogCalls += 1;
    });
    (self as unknown as { postMessage: unknown }).postMessage = (message: {
      type: string;
    }) => {
      postedMessages.push(message);
    };
    await import("./uploadWorker");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("默认关闭：1000 分片上传产生的 debug 消息数与 console 输出均为 0", async () => {
    await runUpload(false);

    const debugMessages = postedMessages.filter((m) => m.type === "debug");
    expect(debugMessages).toHaveLength(0);
    expect(consoleLogCalls).toBe(0);
  });

  it("开启时分片级日志按 200ms 节流（1000 分片 < 20 条），紧急日志不受限", async () => {
    await runUpload(true);

    const debugMessages = postedMessages.filter((m) => m.type === "debug");
    expect(debugMessages.length).toBeGreaterThan(0);
    expect(debugMessages.length).toBeLessThan(20);

    // 紧急日志（请求失败/分片上传失败）不受节流限制，必然出现
    const urgentMessages = debugMessages.filter((m) =>
      /失败|异常|超时|取消/.test(String(m.message))
    );
    expect(urgentMessages.length).toBeGreaterThan(0);

    // 失败分片被上报（证明上传流程真实走完并走了失败分支）
    expect(
      postedMessages.some((m) => m.type === "error" && m.failedChunks)
    ).toBe(true);
  });
});
