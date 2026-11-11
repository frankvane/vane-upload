import { describe, expect, it } from "vitest";
import { joinUrl } from "./url";
import { getAllowedHosts, isUrlAllowed } from "./urlSafety";

describe("urlSafety（F3：SSRF / token 泄漏防护）", () => {
  it("getAllowedHosts 从 baseURL 推导 host（小写、含端口、去重）", () => {
    expect(getAllowedHosts({ baseURL: "https://API.Example.COM:8443/v1" })).toEqual([
      "api.example.com:8443",
    ]);
  });

  it("getAllowedHosts 合并 extraHosts 与 baseURL", () => {
    expect(
      getAllowedHosts({
        baseURL: "https://a.com",
        extraHosts: ["b.com", "https://c.com:9000"],
      })
    ).toEqual(["a.com", "b.com", "c.com:9000"]);
  });

  it("getAllowedHosts 空输入返回空数组", () => {
    expect(getAllowedHosts({})).toEqual([]);
  });

  it("T-31 空白名单不再无条件放行外域（仅同域允许）", () => {
    const origin = "https://app.example.com";
    expect(isUrlAllowed("https://evil.com/x", [], origin)).toBe(false);
    expect(isUrlAllowed("//evil.com/x", [], origin)).toBe(false);
    expect(isUrlAllowed("https://app.example.com/api/file/check", [], origin)).toBe(
      true
    );
  });

  it("isUrlAllowed 命中白名单允许（http/https 同 host 视为一致）", () => {
    expect(isUrlAllowed("https://api.example.com/file", ["api.example.com"])).toBe(
      true
    );
    expect(isUrlAllowed("http://api.example.com/file", ["api.example.com"])).toBe(
      true
    );
    expect(
      isUrlAllowed("https://api.example.com:8443/file", ["api.example.com:8443"])
    ).toBe(true);
  });

  it("isUrlAllowed 非白名单域名拒绝", () => {
    expect(isUrlAllowed("https://evil.com/x", ["api.example.com"])).toBe(false);
  });

  it("isUrlAllowed 解析失败 / 无 host 拒绝", () => {
    expect(isUrlAllowed("not a url", ["api.example.com"])).toBe(false);
  });

  describe("T-31 相对 baseURL 的鉴权头白名单", () => {
    const ORIGIN = "https://app.example.com";

    it("相对 base 是同源，不产生伪 host", () => {
      expect(getAllowedHosts({ baseURL: "/api" })).toEqual([]);
      expect(getAllowedHosts({ baseURL: "/api/v1/" })).toEqual([]);
      expect(getAllowedHosts({ baseURL: "" })).toEqual([]);
    });

    it("相对 URL 在同源下允许携带鉴权头（修复前必 401）", () => {
      const hosts = getAllowedHosts({ baseURL: "/api" });
      expect(isUrlAllowed(joinUrl("/api", "/file/check"), hosts, ORIGIN)).toBe(true);
      expect(isUrlAllowed(joinUrl("/api", "/file/upload"), hosts, ORIGIN)).toBe(true);
      expect(isUrlAllowed(joinUrl("", "/api/file/merge"), hosts, ORIGIN)).toBe(true);
    });

    it("绝对 base 仍按 host 白名单判定", () => {
      expect(getAllowedHosts({ baseURL: "https://cdn.example.com/v1" })).toEqual([
        "cdn.example.com",
      ]);
      expect(
        isUrlAllowed(
          "https://cdn.example.com/v1/file/check",
          ["cdn.example.com"],
          ORIGIN
        )
      ).toBe(true);
    });
  });
});
