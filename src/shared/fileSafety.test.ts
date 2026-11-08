import { describe, expect, it } from "vitest";

import {
  findDangerousFileViolation,
  formatDangerousFileReason,
  getFileExtension,
} from "./fileSafety";

describe("fileSafety（E2E-R2 前后端共用危险类型口径）", () => {
  it("扩展名解析与 path.extname 口径一致", () => {
    expect(getFileExtension("a.exe")).toBe("exe");
    expect(getFileExtension("archive.tar.gz")).toBe("gz");
    expect(getFileExtension("A.EXE")).toBe("exe");
    expect(getFileExtension("noext")).toBe("");
    expect(getFileExtension(".htaccess")).toBe("");
    expect(getFileExtension("trailing.")).toBe("");
  });

  it("危险扩展名命中并给出可读原因", () => {
    const violation = findDangerousFileViolation({
      name: "setup.EXE",
      type: "",
    });

    expect(violation).toEqual({ kind: "extension", value: ".exe" });
    expect(formatDangerousFileReason(violation!)).toContain("危险扩展名 .exe");
  });

  it("危险 MIME 命中（即使扩展名安全）", () => {
    const violation = findDangerousFileViolation({
      name: "page.txt",
      type: "text/html",
    });

    expect(violation).toEqual({ kind: "mime", value: "text/html" });
  });

  it("普通文件不误杀", () => {
    expect(
      findDangerousFileViolation({
        name: "data.bin",
        type: "application/octet-stream",
      })
    ).toBeNull();
    expect(findDangerousFileViolation({ name: "photo.png", type: "image/png" })).toBeNull();
  });
});
