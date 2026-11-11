import { describe, expect, it } from "vitest";

import {
  isBackendUnavailable,
  isCancellation,
  isConnectionFailure,
} from "./errorClassification";

describe("errorClassification · isCancellation", () => {
  it("signal.aborted 为 true 时判定为取消", () => {
    expect(
      isCancellation(new Error("x"), { aborted: true } as AbortSignal),
    ).toBe(true);
    expect(
      isCancellation(new Error("x"), { aborted: false } as AbortSignal),
    ).toBe(false);
  });

  it("AbortError 名称判定为取消", () => {
    const e = new Error("boom");
    e.name = "AbortError";
    expect(isCancellation(e)).toBe(true);
  });

  it("「上传已取消」文案判定为取消，其它文案不误判", () => {
    expect(isCancellation(new Error("上传已取消"))).toBe(true);
    expect(isCancellation(new Error("普通失败"))).toBe(false);
    expect(isCancellation("非 Error")).toBe(false);
  });
});

describe("errorClassification · isConnectionFailure", () => {
  it("识别 TypeError / AbortError / network / timeout / Failed to fetch", () => {
    expect(isConnectionFailure(new TypeError("network"))).toBe(true);
    const ab = new Error("x");
    ab.name = "AbortError";
    expect(isConnectionFailure(ab)).toBe(true);
    expect(isConnectionFailure(new Error("network down"))).toBe(true);
    expect(isConnectionFailure(new Error("request timeout"))).toBe(true);
    expect(isConnectionFailure(new Error("Failed to fetch"))).toBe(true);
  });

  it("普通服务端错误与字符串不误判为连接失败", () => {
    expect(isConnectionFailure(new Error("HTTP 错误 503 boom"))).toBe(false);
    expect(isConnectionFailure(new Error("something else"))).toBe(false);
    expect(isConnectionFailure("string")).toBe(false);
  });
});

describe("errorClassification · isBackendUnavailable", () => {
  it("连接级失败或 5xx 均判为后端不可用", () => {
    expect(isBackendUnavailable(new Error("network error"))).toBe(true);
    expect(isBackendUnavailable(new Error("HTTP 错误 503 boom"))).toBe(true);
  });

  it("4xx 与无关错误不算后端不可用", () => {
    expect(isBackendUnavailable(new Error("HTTP 错误 404"))).toBe(false);
    expect(isBackendUnavailable(new Error("something else"))).toBe(false);
  });
});
