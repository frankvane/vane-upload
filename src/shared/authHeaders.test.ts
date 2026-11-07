import { describe, expect, it, vi } from "vitest";
import { resolveAuthHeaders, resolveRequestCredentials } from "./authHeaders";

describe("resolveAuthHeaders", () => {
  it("getAuthHeaders 优先级最高，直接使用自定义头", async () => {
    const headers = await resolveAuthHeaders({
      authToken: "static",
      getAuthHeaders: async () => ({ "X-Tenant-Id": "t-1" }),
    });

    expect(headers).toEqual({ "X-Tenant-Id": "t-1" });
  });

  it("getAuthHeaders 返回 undefined 时归一为空对象", async () => {
    const headers = await resolveAuthHeaders({
      getAuthHeaders: async () =>
        undefined as unknown as Record<string, string>,
    });

    expect(headers).toEqual({});
  });

  it("getAuthToken 动态取数并拼成默认 Bearer 头", async () => {
    const getAuthToken = vi.fn(async () => "dynamic-token");

    const headers = await resolveAuthHeaders({ getAuthToken });

    expect(headers).toEqual({ Authorization: "Bearer dynamic-token" });
    expect(getAuthToken).toHaveBeenCalledTimes(1);
  });

  it("authToken 静态值按默认 Bearer scheme 拼接", async () => {
    expect(await resolveAuthHeaders({ authToken: "abc" })).toEqual({
      Authorization: "Bearer abc",
    });
  });

  it("authScheme 自定义 scheme 生效", async () => {
    expect(
      await resolveAuthHeaders({ authToken: "abc", authScheme: "Token" })
    ).toEqual({ Authorization: "Token abc" });
  });

  it("无任何鉴权来源时返回空对象", async () => {
    expect(await resolveAuthHeaders({})).toEqual({});
  });
});

describe("resolveRequestCredentials", () => {
  it("缺省 / false 时为 same-origin", () => {
    expect(resolveRequestCredentials()).toBe("same-origin");
    expect(resolveRequestCredentials(false)).toBe("same-origin");
  });

  it("显式 true 时为 include（Cookie 鉴权）", () => {
    expect(resolveRequestCredentials(true)).toBe("include");
  });
});
