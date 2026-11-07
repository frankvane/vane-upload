import { describe, expect, it } from "vitest";

import { joinUrl } from "./url";

describe("joinUrl", () => {
  it("空 base 时原样返回 path（同源相对路径，兼容旧行为）", () => {
    expect(joinUrl("", "/api/file/merge")).toBe("/api/file/merge");
    expect(joinUrl(undefined, "/api/file/merge")).toBe("/api/file/merge");
    expect(joinUrl(null, "api/file/merge")).toBe("api/file/merge");
  });

  it("正常拼接：base 无尾斜杠 + path 带前导斜杠", () => {
    expect(joinUrl("https://x.com", "/api/merge")).toBe(
      "https://x.com/api/merge"
    );
  });

  it("base 带尾斜杠时不产生双斜杠", () => {
    expect(joinUrl("https://x.com/", "/api/merge")).toBe(
      "https://x.com/api/merge"
    );
    expect(joinUrl("https://x.com///", "///api/merge")).toBe(
      "https://x.com/api/merge"
    );
  });

  it("path 不带前导斜杠时自动补一个", () => {
    expect(joinUrl("https://x.com/", "api/merge")).toBe(
      "https://x.com/api/merge"
    );
    expect(joinUrl("https://x.com", "api/merge")).toBe(
      "https://x.com/api/merge"
    );
  });

  it("base 带路径前缀时保留前缀", () => {
    expect(joinUrl("https://x.com/base", "/api/x")).toBe(
      "https://x.com/base/api/x"
    );
    expect(joinUrl("https://x.com/base/", "api/x")).toBe(
      "https://x.com/base/api/x"
    );
  });

  it("空 path 时返回 base（去掉尾斜杠不做强制规范）", () => {
    expect(joinUrl("https://x.com", "")).toBe("https://x.com");
    expect(joinUrl("", "")).toBe("");
  });

  it("相对 base（如 /api）同样正确拼接", () => {
    expect(joinUrl("/api", "/file/merge")).toBe("/api/file/merge");
    expect(joinUrl("/api/", "file/merge")).toBe("/api/file/merge");
  });

  it("不再出现 `//api/` 形式（回归 P1-5）", () => {
    const url = joinUrl("https://upload.example.com/", "/api/file/merge");
    expect(url).toBe("https://upload.example.com/api/file/merge");
    expect(url).not.toContain("//api");
  });
});
