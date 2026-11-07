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
});
