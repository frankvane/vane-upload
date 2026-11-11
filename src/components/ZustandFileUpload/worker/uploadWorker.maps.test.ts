import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-56：Worker 3 个模块级任务 Map（taskAbortControllers / taskAllowedHosts /
 * taskStats）必须在每个任务结束（成功 / 取消 / 秒传短路 /
 * 后端不可用任一提前 return）后清空，不得跨任务残留。T-57 删除 taskPauseState 后剩 3 个。
 *
 * 直接加载 uploadWorker 模块（注册 self.onmessage），mock fetch 让 /instant 命中
 * 秒传（uploaded:true），复用同一模块实例连续派发两个秒传任务，断言 4 个 Map 尺寸全 0。
 */

const postedMessages: Array<{ type: string; [key: string]: unknown }> = [];

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const instantFetchMock = vi.fn(async (url: string, options?: RequestInit) => {
  if (String(url).includes("/instant")) {
    // 秒传命中：file_id 非 normal 系列 → uploaded=true 走 fast path；
    // normal 系列 → uploaded=false，继续常规上传（到达 /upload）。
    let uploaded = true;
    try {
      const body = options?.body ? JSON.parse(String(options.body)) : {};
      // file_id 是 hash（非任务 id），用 name（=`${id}.bin`）区分秒传/普通任务
      if (String(body.name ?? "").startsWith("normal")) uploaded = false;
    } catch {
      /* 解析失败不影响判定 */
    }
    return jsonResponse({ code: 200, data: { uploaded } });
  }
  if (String(url).includes("/status")) {
    return jsonResponse({ code: 200, data: { chunks: [] } });
  }
  if (String(url).includes("/merge")) {
    return jsonResponse({ code: 200 });
  }
  // 分片上传：挂起直到 signal 被取消（模拟在途请求），供 cancel 路径收敛。
  return new Promise<Response>((_resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }
    signal?.addEventListener(
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

const buildUploadMessage = (id: string, fileSize: number) => ({
  type: "upload" as const,
  fileInfo: {
    id,
    fileName: `${id}.bin`,
    fileSize,
    hash: "0".repeat(32),
    chunkSize: 1024 * 1024,
    chunkKey: `${"0".repeat(32)}_${fileSize}_${1024 * 1024}`,
  },
  fileRef: new File([new Uint8Array(Math.min(fileSize, 1)).fill(1)], `${id}.bin`),
  networkParams: { chunkConcurrency: 1, maxRetries: 1 },
  uploadConfig: {
    baseURL: "",
    uploadApi: "/api/file/upload",
    checkApi: "/api/file/instant",
    mergeApi: "/api/file/merge",
  },
});

describe("uploadWorker 任务 Map 清理（T-56）", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", instantFetchMock);
    instantFetchMock.mockClear();
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

  it("连续派发两个秒传任务后，4 个任务 Map 全部清空（无跨任务残留）", async () => {
    const { __test_getTaskMapSizes } = await import("./uploadWorker");

    await dispatch(buildUploadMessage("instant-a", 2 * 1024 * 1024));
    await dispatch(buildUploadMessage("instant-b", 3 * 1024 * 1024));

    expect(
      postedMessages.filter((m) => m.type === "done" && m.skipped === true)
        .length
    ).toBe(2);

    // 两个秒传任务均走外层 finally 清理：3 个 Map 不得残留任何条目。
    expect(__test_getTaskMapSizes()).toEqual({
      abort: 0,
      hosts: 0,
      stats: 0,
    });
  });

  it("秒传任务结束后，第二个普通上传任务可正常复用同一模块实例（Map 仍清空）", async () => {
    const { __test_getTaskMapSizes } = await import("./uploadWorker");

    // 第一个：秒传短路
    await dispatch(buildUploadMessage("instant-first", 1 * 1024 * 1024));
    expect(
      postedMessages.some((m) => m.type === "done" && m.skipped === true)
    ).toBe(true);
    expect(__test_getTaskMapSizes()).toEqual({
      abort: 0,
      hosts: 0,
      stats: 0,
    });

    // 第二个：普通上传（/instant 不命中，但此测试只关心 Map 清理，不阻塞于分片上传）
    postedMessages.length = 0;
    const normalPromise = dispatch(
      buildUploadMessage("normal-second", 1 * 1024 * 1024)
    );
    // 普通上传会停在分片上传阶段（instantFetchMock 对 /upload 返回空 200，不 resolve 业务），
    // 直接 CANCEL 以触发收敛路径，验证所有 Map 清理。
    await vi.waitFor(() => {
      expect(
        instantFetchMock.mock.calls.some(([url]) => String(url).includes("/upload"))
      ).toBe(true);
    });
    await dispatch({ type: "cancel", fileId: "normal-second" });
    await normalPromise;

    expect(__test_getTaskMapSizes()).toEqual({
      abort: 0,
      hosts: 0,
      stats: 0,
    });
  });
});
