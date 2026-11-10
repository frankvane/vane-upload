/**
 * T-17：fetchWithRetry 抽出后脱离 Worker 全局，可直接 spy fetch 验证重试语义。
 * 这些断言原先只能靠整条上传链路间接观察（E2E-04），现在能单点定位。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, type FetchRetryDeps } from "./fetchWithRetry";

const URL_SAFE = "https://allowed.example.com/api";
const ok = () => new Response("ok");
const badGateway = () =>
  new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" });

let deps: FetchRetryDeps;
let debug: ReturnType<typeof vi.fn>;
let postMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  debug = vi.fn();
  postMessage = vi.fn();
  deps = {
    debug: debug as unknown as FetchRetryDeps["debug"],
    postMessage: postMessage as unknown as FetchRetryDeps["postMessage"],
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchWithRetry（T-17 独立直测）", () => {
  it("合并鉴权头：调用方显式 headers 优先，credentials 默认 same-origin", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());

    const res = await fetchWithRetry(
      URL_SAFE,
      { method: "POST", headers: { Authorization: "Bearer explicit" } },
      {
        authHeaders: { Authorization: "Bearer auto", "X-Trace": "1" },
        allowedHosts: ["allowed.example.com"],
      },
      deps,
    );

    expect(res.status).toBe(200);
    const [, init] = spy.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer explicit");
    expect(headers["X-Trace"]).toBe("1");
    expect(init?.credentials).toBe("same-origin");
  });

  it("非白名单 host 不携带鉴权头（F3：防 token 外泄）", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());

    await fetchWithRetry(
      "https://evil.example.com/api",
      { method: "GET" },
      {
        authHeaders: { Authorization: "Bearer secret" },
        allowedHosts: ["allowed.example.com"],
      },
      deps,
    );

    const headers = spy.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("5xx 按 retryInterval 退避重试，成功后只请求两次", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(badGateway())
      .mockResolvedValueOnce(ok());

    const res = await fetchWithRetry(
      URL_SAFE,
      { method: "GET" },
      { maxRetries: 3, retryInterval: 0 },
      deps,
    );

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("5xx 耗尽重试后拒绝，且不会多打一次请求", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(badGateway());

    await expect(
      fetchWithRetry(
        URL_SAFE,
        { method: "GET" },
        { maxRetries: 2, retryInterval: 0 },
        deps,
      ),
    ).rejects.toThrow("HTTP 错误 502");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("maxRetries=0 时不上报模糊错误，而是发出 retry 消息后拒绝", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());

    await expect(
      fetchWithRetry(URL_SAFE, { method: "GET" }, { maxRetries: 0 }, deps),
    ).rejects.toThrow("已达到最大重试次数: 0");

    expect(spy).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "retry",
        attemptNumber: 0,
        retriesLeft: 0,
      }),
    );
  });

  it("E2E-04：连接级错误立即失败，不按 maxRetries 反复等待", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(
      fetchWithRetry(
        URL_SAFE,
        { method: "GET" },
        { maxRetries: 5, retryInterval: 0 },
        deps,
      ),
    ).rejects.toThrow("Failed to fetch");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("任务已取消时不再发起请求，抛 AbortError 而非普通失败", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchWithRetry(
        URL_SAFE,
        { method: "GET" },
        { signal: controller.signal },
        deps,
      ),
    ).rejects.toMatchObject({ name: "AbortError", message: "上传已取消" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("debug 未开启时仍可正常请求（deps 注入不参与控制流）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
    const res = await fetchWithRetry(URL_SAFE, { method: "GET" }, {}, deps);
    expect(res.ok).toBe(true);
    expect(debug).toHaveBeenCalled();
  });
});
