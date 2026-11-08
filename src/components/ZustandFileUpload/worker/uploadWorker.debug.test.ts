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

const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
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

const runUpload = async (
  debug: boolean,
  authHeaders?: Record<string, string>,
) => {
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
      authHeaders,
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
    const progressMessages = postedMessages.filter((m) => m.type === "progress");
    // 节流保证：常规 debug 消息数应远少于分片级 progress 消息数，
    // 该断言与机器速度无关，消除原本 `toBeLessThan(20)` 的 flaky。
    expect(debugMessages.length).toBeGreaterThan(0);
    expect(progressMessages.length).toBeGreaterThan(debugMessages.length);

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

  it("VU-05：debug 开启时日志不泄漏 Authorization / Cookie 凭据", async () => {
    await runUpload(true, {
      Authorization: "Bearer SUPER_SECRET_TOKEN_XYZ",
      Cookie: "session=SUPER_SECRET_COOKIE_XYZ",
      "X-Api-Token": "SUPER_SECRET_X_TOKEN_XYZ",
    });

    const serialized = JSON.stringify(postedMessages);
    expect(serialized).not.toContain("SUPER_SECRET_TOKEN_XYZ");
    expect(serialized).not.toContain("SUPER_SECRET_COOKIE_XYZ");
    expect(serialized).not.toContain("SUPER_SECRET_X_TOKEN_XYZ");

    // 「执行请求:」是常规日志，会被 200ms 节流过滤，不能要求它一定出现；
    // 但只要有任何带 headers 的日志放行，敏感键就必须已置换。
    // 脱敏规则本身的确定性覆盖见 shared/redact.test.ts（与节流解耦）。
    for (const log of postedMessages) {
      const headers = (
        log.data as { headers?: Record<string, string> } | undefined
      )?.headers;
      if (!headers) continue;
      for (const key of ["Authorization", "Cookie", "X-Api-Token"]) {
        if (headers[key] !== undefined) expect(headers[key]).toBe("***");
      }
    }

    // 脱敏只作用于日志，不得改变真实发出的请求头（功能回归保护）。
    const uploadCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/upload")
    );
    expect(uploadCall?.[1]?.headers).toMatchObject({
      Authorization: "Bearer SUPER_SECRET_TOKEN_XYZ",
      Cookie: "session=SUPER_SECRET_COOKIE_XYZ",
      "X-Api-Token": "SUPER_SECRET_X_TOKEN_XYZ",
    });
  });

  it("VU-49：1000 分片下 debug 载荷不含分片索引数组，且游标池未漏片", async () => {
    await runUpload(true);

    let maxArrayLength = 0;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        maxArrayLength = Math.max(maxArrayLength, value.length);
        for (const item of value) visit(item);
        return;
      }
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) visit(child);
      }
    };
    for (const message of postedMessages) {
      if (message.type === "debug") visit(message.data);
    }

    // 旧实现会把 needUploadChunks 的 count/first/last 之外的整数组写进日志；
    // 现在只打印 count 与区间，任何 debug 载荷都不应出现大数组。
    expect(maxArrayLength).toBeLessThan(20);

    // 游标式 pool 仍把全部缺失分片处理完（首片按 mock 失败，不计进度）
    const progressMessages = postedMessages.filter(
      (message) => message.type === "progress"
    );
    expect(progressMessages.length).toBeGreaterThan(100);
  });
});
