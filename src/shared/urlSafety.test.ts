import { describe, expect, it } from "vitest";
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

  it("isUrlAllowed 空白名单允许（向后兼容，调用方保证 baseURL 可信）", () => {
    expect(isUrlAllowed("https://evil.com/x", [])).toBe(true);
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
});
