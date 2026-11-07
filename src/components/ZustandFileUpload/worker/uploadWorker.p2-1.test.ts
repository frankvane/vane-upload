import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P2-1：非秒传链路不再在首片上传前预计算全部分片 MD5。
 * 可观测行为：
 *   1. 预检请求体不再携带全量 chunk_md5s；
 *   2. 先查 /status 拿到已存在分片，只上传缺失分片；
 *   3. 上传请求按片携带 chunk_md5（按需计算）。
 */

const postedMessages: Array<{ type: string; [key: string]: unknown }> = [];

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const target = String(input);
  if (target.includes("/instant")) {
    return jsonResponse({ code: 200, data: { uploaded: false } });
  }
  if (target.includes("/status")) {
    // 第 0 片已存在，第 1、2 片缺失
    return jsonResponse({ code: 200, data: { chunks: [0] } });
  }
  if (target.includes("/upload")) {
    return jsonResponse({ code: 200, data: {} });
  }
  if (target.includes("/merge")) {
    return jsonResponse({ code: 200, data: {} });
  }
  return jsonResponse({ code: 200, data: {} });
});

const dispatch = (data: unknown) => {
  const handler = (self as unknown as { onmessage: (e: MessageEvent) => void })
    .onmessage;
  return handler({ data } as MessageEvent);
};

describe("uploadWorker P2-1 分片 MD5 按需计算", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
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

  it("先查 status 只传缺失分片，且请求体不含全量 chunk_md5s", async () => {
    const fileRef = new File([new Uint8Array(3072).fill(9)], "p21.bin");

    await dispatch({
      type: "upload",
      fileInfo: {
        id: "p2-1-case",
        fileName: "p21.bin",
        fileSize: 3072,
        hash: "2".repeat(32),
        chunkSize: 1024,
        chunkKey: `${"2".repeat(32)}_3072_1024`,
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

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      body: init?.body,
    }));

    // 1. 预检（instant）不再携带 chunk_md5s
    const instantCalls = calls.filter((call) => call.url.includes("/instant"));
    expect(instantCalls.length).toBeGreaterThan(0);
    for (const call of instantCalls) {
      expect(String(call.body)).not.toContain("chunk_md5s");
    }

    // 2. 状态查询发生在上传之前
    const statusIndex = calls.findIndex((call) => call.url.includes("/status"));
    const firstUploadIndex = calls.findIndex((call) =>
      call.url.includes("/upload")
    );
    expect(statusIndex).toBeGreaterThanOrEqual(0);
    expect(firstUploadIndex).toBeGreaterThan(statusIndex);

    // 3. 只上传缺失分片 1、2，已存在的 0 片跳过
    const uploadedIndexes = calls
      .filter((call) => call.url.includes("/upload"))
      .map((call) => Number((call.body as FormData).get("index")))
      .sort((a, b) => a - b);
    expect(uploadedIndexes).toEqual([1, 2]);

    // 4. 上传请求按片携带 chunk_md5（按需计算）
    for (const call of calls.filter((item) => item.url.includes("/upload"))) {
      const body = call.body as FormData;
      expect(String(body.get("chunk_md5"))).toMatch(/^[a-f0-9]{32}$/);
    }

    expect(postedMessages.some((message) => message.type === "done")).toBe(true);
  });
});
