import { describe, expect, it } from "vitest";

import { UploadStatus } from "../types/upload";
import {
  UPLOAD_SCHEMA_VERSION,
  migrateUploadFile,
  stampUploadSchema,
} from "./uploadSchema";

describe("uploadSchema（P2-4 迁移层）", () => {
  it("旧记录（无 schemaVersion、历史状态字符串）被补齐并映射为当前枚举", () => {
    const result = migrateUploadFile({
      id: "legacy-1",
      fileName: "old.bin",
      fileSize: 2048,
      status: "success",
      createdAt: 1700000000000,
    });

    expect(result).not.toBeNull();
    expect(result!.migrated).toBe(true);
    expect(result!.file.status).toBe(UploadStatus.DONE);
    expect(result!.file.schemaVersion).toBe(UPLOAD_SCHEMA_VERSION);
    // 缺失字段补默认值，避免下游 undefined 参与计算
    expect(result!.file.progress).toBe(0);
    expect(result!.file.fileType).toBe("");
    expect(result!.file.lastModified).toBe(1700000000000);
    expect(result!.file.order).toBe(1700000000000);
  });

  it("历史 uploading / failed 状态分别映射为 UPLOADING / ERROR", () => {
    const uploading = migrateUploadFile({
      id: "a",
      fileName: "a.bin",
      status: "uploading",
      createdAt: 1,
    });
    const failed = migrateUploadFile({
      id: "b",
      fileName: "b.bin",
      status: "failed",
      createdAt: 1,
    });
    expect(uploading?.file.status).toBe(UploadStatus.UPLOADING);
    expect(failed?.file.status).toBe(UploadStatus.ERROR);
  });

  it("未知状态保守降级为 PAUSED（不自动续传）", () => {
    const result = migrateUploadFile({
      id: "weird",
      fileName: "w.bin",
      status: "some-future-status",
      createdAt: 1,
    });
    expect(result?.file.status).toBe(UploadStatus.PAUSED);
  });

  it("progress 越界被裁剪到 [0,100]", () => {
    expect(
      migrateUploadFile({ id: "p1", fileName: "p", createdAt: 1, progress: 180 })
        ?.file.progress
    ).toBe(100);
    expect(
      migrateUploadFile({ id: "p2", fileName: "p", createdAt: 1, progress: -5 })
        ?.file.progress
    ).toBe(0);
  });

  it("结构性损坏（缺 id / fileName / createdAt）返回 null", () => {
    expect(migrateUploadFile(null)).toBeNull();
    expect(migrateUploadFile("nope")).toBeNull();
    expect(migrateUploadFile({ fileName: "x", createdAt: 1 })).toBeNull();
    expect(migrateUploadFile({ id: "x", createdAt: 1 })).toBeNull();
    expect(migrateUploadFile({ id: "x", fileName: "y" })).toBeNull();
  });

  it("已是当前版本的记录 migrated=false", () => {
    const result = migrateUploadFile({
      id: "cur",
      fileName: "cur.bin",
      createdAt: 1,
      status: UploadStatus.UPLOADING,
      schemaVersion: UPLOAD_SCHEMA_VERSION,
    });
    expect(result?.migrated).toBe(false);
  });

  it("stampUploadSchema 给对象盖章，非对象原样返回", () => {
    expect(stampUploadSchema({ id: "x" })).toEqual({
      id: "x",
      schemaVersion: UPLOAD_SCHEMA_VERSION,
    });
    expect(stampUploadSchema("raw")).toBe("raw");
    expect(stampUploadSchema(null)).toBeNull();
  });

  // T-73 ⑤-A：createdAt 脏值表驱动。迁移层必须把非有限数 / 非 number 记录
  // 判为「结构性损坏」直接丢弃，否则 NaN 会进入 files.sort 的差值运算，
  // 让排序结果取决于引擎实现（V8 稳定排序下会保持乱序）。
  it.each([
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["字符串", "1700000000000"],
    ["null", null],
    ["undefined", undefined],
    ["对象", {}],
    ["包装对象", new Number(1)],
    ["布尔", true],
  ] as const)("createdAt=%s 的记录被判为损坏并丢弃", (_label, createdAt) => {
    expect(
      migrateUploadFile({ id: "dirty", fileName: "dirty.bin", createdAt })
    ).toBeNull();
  });

  it("createdAt=-0 / 极大有限值仍保留为有效时间戳（不过度拒绝）", () => {
    const minusZero = migrateUploadFile({
      id: "z",
      fileName: "z.bin",
      createdAt: -0,
      schemaVersion: UPLOAD_SCHEMA_VERSION,
    });
    expect(minusZero).not.toBeNull();
    expect(Object.is(minusZero!.file.createdAt, -0)).toBe(true);
    expect(minusZero!.file.lastModified).toBe(-0);
    expect(minusZero!.file.order).toBe(-0);

    const large = migrateUploadFile({
      id: "big",
      fileName: "big.bin",
      createdAt: Number.MAX_SAFE_INTEGER,
    });
    expect(large!.file.createdAt).toBe(Number.MAX_SAFE_INTEGER);
    expect(large!.migrated).toBe(true);
  });

  // LEGACY_STATUS_MAP 全 16 项：逐项锁定映射结果，避免未来改表时静默漏项。
  it.each([
    ["pending", UploadStatus.QUEUED],
    ["waiting", UploadStatus.QUEUED],
    ["queued", UploadStatus.QUEUED],
    ["uploading", UploadStatus.UPLOADING],
    ["uploading_chunk", UploadStatus.UPLOADING],
    ["preparing", UploadStatus.PREPARING_UPLOAD],
    ["success", UploadStatus.DONE],
    ["complete", UploadStatus.DONE],
    ["completed", UploadStatus.DONE],
    ["done", UploadStatus.DONE],
    ["fail", UploadStatus.ERROR],
    ["failed", UploadStatus.ERROR],
    ["error", UploadStatus.ERROR],
    ["canceled", UploadStatus.PAUSED],
    ["cancelled", UploadStatus.PAUSED],
    ["stopped", UploadStatus.PAUSED],
  ] as const)("历史状态 %s → %s", (legacy, expected) => {
    const result = migrateUploadFile({
      id: "legacy",
      fileName: "legacy.bin",
      status: legacy,
      createdAt: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.file.status).toBe(expected);
    expect(result!.migrated).toBe(true);
  });

  it.each(["SUCCESS", "Failed", "CaNcElLeD", "UPLOADING_CHUNK"] as const)(
    "历史状态大小写变体 %s 仍精确映射（toLowerCase 归一化）",
    (legacy) => {
      const expected = migrateUploadFile({
        id: "case",
        fileName: "case.bin",
        status: legacy.toLowerCase(),
        createdAt: 1,
      })!.file.status;
      const actual = migrateUploadFile({
        id: "case",
        fileName: "case.bin",
        status: legacy,
        createdAt: 1,
      })!.file.status;
      expect(actual).toBe(expected);
    }
  );

  it("当前枚举值优先于历史映射表，不被 toLowerCase 误伤", () => {
    // "queued-for-upload" 含连字符，历史表里没有；VALID_STATUS 命中才正确。
    const result = migrateUploadFile({
      id: "cur",
      fileName: "cur.bin",
      status: UploadStatus.QUEUED_FOR_UPLOAD,
      createdAt: 1,
      schemaVersion: UPLOAD_SCHEMA_VERSION,
    });
    expect(result!.file.status).toBe(UploadStatus.QUEUED_FOR_UPLOAD);
    expect(result!.migrated).toBe(false);
  });

  // Unicode / 双向控制符脏记录：迁移层只做规整，不改写文件名（清洗在后端 T-75），
  // 但必须逐字节原样带回，且不得因长度截断留下孤立 surrogate。
  it.each([
    ["RTL 覆写 U+202E", "report\u202Etxt.exe", "u-rtl"],
    ["LRI 隔离 U+2066", "\u2066invoice.pdf", "u-lri"],
    ["零宽空格 U+200B", "photo\u200B.png", "u-zwsp"],
    ["全角斜杠 U+FF0F", "a\uFF0Fb.txt", "u-fullslash"],
    ["组合字符 NFD", "cafe\u0301.txt", "u-nfd"],
    ["emoji 代理对", "\u{1F4C4}-report.txt", "u-emoji"],
  ] as const)("Unicode 记录 %s 的 id / fileName 原样保留", (_label, fileName, id) => {
    const result = migrateUploadFile({
      id,
      fileName,
      createdAt: 1,
      status: "success",
      progress: 100,
    });
    expect(result).not.toBeNull();
    expect(result!.file.id).toBe(id);
    expect(result!.file.fileName).toBe(fileName);
    expect(result!.file.fileName.length).toBe(fileName.length);
    expect(result!.file.status).toBe(UploadStatus.DONE);
    expect(result!.file.schemaVersion).toBe(UPLOAD_SCHEMA_VERSION);
  });

  it.each([
    ["数组", [1, 2, 3]],
    ["数字", 42],
    ["布尔", false],
    ["函数", () => undefined],
    ["空字符串", ""],
  ] as const)("非对象 raw=%s 被丢弃而不抛异常", (_label, raw) => {
    expect(migrateUploadFile(raw)).toBeNull();
  });

  it("数组形态的 raw 因缺 id 被丢弃（不把下标当文件名）", () => {
    expect(migrateUploadFile(["a.bin"])).toBeNull();
  });
});
