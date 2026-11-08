import { describe, expect, it } from "vitest";
import { compileAllowedTypes, isFileTypeAllowed } from "./fileType";

const file = (name: string, type: string) => ({ name, type });

/**
 * VU-37：等价类 + 边界值 + 错误推测。
 * 重点锁定旧 `String.includes` 的两类缺陷：伪造 MIME 被误放行、image/* 永不命中。
 */
describe("shared/fileType（VU-37 白名单精确匹配）", () => {
  it("空白名单不限制任何文件（与旧 length>0 语义一致）", () => {
    const matcher = compileAllowedTypes([]);
    expect(
      isFileTypeAllowed(file("a.exe", "application/octet-stream"), matcher),
    ).toBe(true);
  });

  it("扩展名匹配大小写不敏感，且不再靠子串包含", () => {
    const matcher = compileAllowedTypes([".PNG"]);
    expect(isFileTypeAllowed(file("photo.PNG", ""), matcher)).toBe(true);
    expect(isFileTypeAllowed(file("photo.png-fake", ""), matcher)).toBe(false);
  });

  it("精确 MIME 不放行带后缀的伪造类型", () => {
    const matcher = compileAllowedTypes(["image/png"]);
    expect(isFileTypeAllowed(file("a.png", "IMAGE/PNG"), matcher)).toBe(true);
    expect(isFileTypeAllowed(file("evil.png", "image/png-fake"), matcher)).toBe(
      false,
    );
  });

  it("image/* 通配按 MIME 前缀命中", () => {
    const matcher = compileAllowedTypes(["image/*"]);
    expect(isFileTypeAllowed(file("a.png", "image/png"), matcher)).toBe(true);
    expect(isFileTypeAllowed(file("a.svg", "image/svg+xml"), matcher)).toBe(true);
    expect(isFileTypeAllowed(file("a.txt", "text/plain"), matcher)).toBe(false);
  });

  it("扩展名 / 精确 MIME / 通配混合时按并集判定", () => {
    const matcher = compileAllowedTypes([
      ".pdf",
      "image/*",
      "application/json",
    ]);
    expect(isFileTypeAllowed(file("doc.pdf", ""), matcher)).toBe(true);
    expect(isFileTypeAllowed(file("a.gif", "image/gif"), matcher)).toBe(true);
    expect(
      isFileTypeAllowed(file("data.json", "application/json"), matcher),
    ).toBe(true);
    expect(
      isFileTypeAllowed(file("x.bin", "application/octet-stream"), matcher),
    ).toBe(false);
  });

  it("编译结果是快照，不受原数组后续修改影响", () => {
    const types = [".png"];
    const matcher = compileAllowedTypes(types);
    types.push(".exe");
    expect(isFileTypeAllowed(file("malware.exe", ""), matcher)).toBe(false);
  });
});
