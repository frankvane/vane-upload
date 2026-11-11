import { afterEach, describe, expect, it, vi } from "vitest";

import { createDebugChannel } from "./debugChannel";

describe("debugChannel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("默认关闭：debug 不产生任何输出", () => {
    const post = vi.fn();
    const { debug } = createDebugChannel(post);
    debug("hello");
    debug("world", { a: 1 });
    expect(post).not.toHaveBeenCalled();
  });

  it("setEnabled(true) 后常规日志按 200ms 节流（窗口内重复被吞）", () => {
    vi.useFakeTimers();
    const post = vi.fn();
    const { debug, setEnabled } = createDebugChannel(post);
    setEnabled(true);

    debug("first");
    debug("second");
    expect(post).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(201);
    debug("third");
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("urgent 日志不受节流限制", () => {
    vi.useFakeTimers();
    const post = vi.fn();
    const { debug, setEnabled } = createDebugChannel(post);
    setEnabled(true);

    debug("a", undefined, true);
    debug("b", undefined, true);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("出站日志脱敏：headers 敏感键被置换，明文凭据不泄漏", () => {
    const post = vi.fn();
    const { debug, setEnabled } = createDebugChannel(post);
    setEnabled(true);

    debug("login", {
      headers: { authorization: "Bearer secret-token", ok: "1" },
    });

    expect(post).toHaveBeenCalledTimes(1);
    // post.mock.calls[i] 是「第 i 次调用的参数数组」，本调用仅 1 个参数 → 取 [0][0]。
    const calls = post.mock.calls as unknown as Array<
      Array<{ type: string; data: Record<string, unknown> }>
    >;
    const msg = calls[0]![0]!;
    expect(msg.type).toBe("debug");
    expect(msg.data.headers).toEqual({ authorization: "***", ok: "1" });
    expect(JSON.stringify(msg)).not.toContain("secret-token");
  });

  it("关闭后再次开启仍正常输出（节流窗口外）", () => {
    vi.useFakeTimers();
    const post = vi.fn();
    const { debug, setEnabled } = createDebugChannel(post);
    setEnabled(true);
    debug("x");
    setEnabled(false);
    debug("y");
    vi.advanceTimersByTime(201);
    setEnabled(true);
    debug("z");
    expect(post).toHaveBeenCalledTimes(2);
  });
});
