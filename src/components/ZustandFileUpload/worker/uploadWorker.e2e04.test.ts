/**
 * E2E-04：后端不可用时快速失败。
 *
 * 断言目标：
 * 1. 预检 + 状态查询都失败（连接级错误或 5xx）→ 立即上报可读错误，不进入分片上传；
 * 2. 单个分片遭遇连接级错误 → 停止领取剩余分片，不再把整文件白跑一遍。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postedMessages: Array<{ type: string; [key: string]: unknown }> = [];

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const dispatch = (data: unknown) => {
  const handler = (self as unknown as { onmessage: (e: MessageEvent) => void })
    .onmessage;
  return handler({ data } as MessageEvent);
};

const runUpload = async (chunkCount: number, maxRetries = 3) => {
  const fileRef = new File(
    [new Uint8Array(chunkCount).fill(7)],
    "e2e04.bin"
  );
  await dispatch({
    type: "upload",
    fileInfo: {
      id: `e2e04-${chunkCount}`,
      fileName: "e2e04.bin",
      fileSize: chunkCount,
      hash: "b".repeat(32),
      chunkSize: 1,
      chunkKey: `${"b".repeat(32)}_${chunkCount}_1`,
    },
    fileRef,
    networkParams: { chunkConcurrency: 4, maxRetries },
    uploadConfig: {
      baseURL: "",
      uploadApi: "/api/file/upload",
      checkApi: "/api/file/instant",
      mergeApi: "/api/file/merge",
    },
  });
};

const uploadCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes("/upload"));

const fetchMock = vi.fn();

describe("uploadWorker E2E-04 后端不可用快速失败", () => {
  beforeEach(async () => {
    postedMessages.length = 0;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
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

  it("预检与状态查询均为连接级错误：立即报错且不发生分片上传", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await runUpload(50);

    const errorMessage = postedMessages.find(
      (message) => message.type === "error"
    );
    expect(errorMessage?.message).toContain("无法连接服务器");
    // 连接级错误不再重试：只探测 2 次（instant + status），不进入 /upload
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(uploadCalls()).toHaveLength(0);
  });

  it("预检与状态查询均为 502：立即报错且不发生分片上传", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ message: "Bad Gateway" }, 502)
    );

    await runUpload(50, 1);

    const errorMessage = postedMessages.find(
      (message) => message.type === "error"
    );
    expect(errorMessage?.message).toContain("无法连接服务器");
    expect(uploadCalls()).toHaveLength(0);
  });

  it("单个分片遭遇连接级错误：停止领取剩余分片，不做整文件白跑", async () => {
    let uploadCount = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      if (target.includes("/instant")) {
        return jsonResponse({ code: 200, data: { uploaded: false } });
      }
      if (target.includes("/status")) {
        return jsonResponse({ code: 200, data: { chunks: [] } });
      }
      uploadCount += 1;
      if (uploadCount >= 6) {
        throw new TypeError("Failed to fetch");
      }
      return jsonResponse({ code: 200 });
    });

    await runUpload(200);

    const errorMessage = postedMessages.find(
      (message) => message.type === "error"
    );
    expect(errorMessage?.message).toContain("无法连接服务器");
    // 200 个分片不应全部发出；命中连接级错误后最多再带上几个在途分片
    expect(uploadCalls().length).toBeLessThan(20);
  });
});
