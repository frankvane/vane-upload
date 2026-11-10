import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-27：静态 authToken 的开发期告警。
 * 每个用例重新加载模块，才能重置「单次告警」的模块级标记；
 * `vi.doMock("./isDev", ...)` 同时覆盖 dev 与 prod 两条分支。
 */
beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

const loadAuthHeaders = async (isDev: boolean) => {
  vi.doMock("./isDev", () => ({ IS_DEV: isDev }));
  return import("./authHeaders");
};

const silenceWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

describe("T-27 静态 authToken 开发期告警", () => {
  it("dev 下静态 token 只告警一次，且提示改用 getAuthToken", async () => {
    const warn = silenceWarn();
    const { resolveAuthHeaders, warnIfStaticAuthToken } = await loadAuthHeaders(true);

    await resolveAuthHeaders({ authToken: "hardcoded-1" });
    warnIfStaticAuthToken({ authToken: "hardcoded-1" });
    await resolveAuthHeaders({ authToken: "hardcoded-2" });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("getAuthToken");
    expect(warn.mock.calls[0]?.[0]).toContain("bundle");
  });

  it("传 getAuthToken 时不告警", async () => {
    const warn = silenceWarn();
    const { resolveAuthHeaders } = await loadAuthHeaders(true);

    const headers = await resolveAuthHeaders({
      authToken: "hardcoded",
      getAuthToken: () => "fresh",
    });

    expect(headers).toEqual({ Authorization: "Bearer fresh" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("静态 token 为空时不告警", async () => {
    const warn = silenceWarn();
    const { resolveAuthHeaders, warnIfStaticAuthToken } = await loadAuthHeaders(true);

    await resolveAuthHeaders({ authToken: "" });
    warnIfStaticAuthToken({});

    expect(warn).not.toHaveBeenCalled();
  });

  it("getAuthHeaders 覆盖鉴权时仍告警：字面量依旧留在 bundle 里", async () => {
    const warn = silenceWarn();
    const { resolveAuthHeaders } = await loadAuthHeaders(true);

    const headers = await resolveAuthHeaders({
      authToken: "hardcoded",
      getAuthHeaders: () => ({ "X-Tenant": "t-1" }),
    });

    expect(headers).toEqual({ "X-Tenant": "t-1" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("prod 分支不产生任何告警，鉴权结果不受影响", async () => {
    const warn = silenceWarn();
    const { resolveAuthHeaders, warnIfStaticAuthToken } = await loadAuthHeaders(false);

    warnIfStaticAuthToken({ authToken: "hardcoded" });
    const headers = await resolveAuthHeaders({ authToken: "hardcoded" });

    expect(warn).not.toHaveBeenCalled();
    expect(headers).toEqual({ Authorization: "Bearer hardcoded" });
  });
});
