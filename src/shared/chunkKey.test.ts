import { describe, expect, it } from "vitest";

import { buildChunkKey } from "./chunkKey";

// 与 server/src/utils/fileSecurity.js 的 sanitizeFileId 白名单保持一致
const SANITIZE_FILE_ID = (value: string) =>
  value.replace(/[^a-zA-Z0-9_-]/g, "");

describe("buildChunkKey（T2.2 分片存储键）", () => {
  it("生成 `${md5}_${size}_${chunkSize}` 复合键", () => {
    expect(buildChunkKey("a".repeat(32), 1048576, 4194304)).toBe(
      `${"a".repeat(32)}_1048576_4194304`
    );
  });

  it("不同 chunkSize 生成不同键（网络自适应后分片不互相污染，P1-6）", () => {
    const md5 = "b".repeat(32);
    const big = buildChunkKey(md5, 1000, 8 * 1024 * 1024);
    const small = buildChunkKey(md5, 1000, 256 * 1024);
    expect(big).not.toBe(small);
  });

  it("不同 size 生成不同键", () => {
    const md5 = "c".repeat(32);
    expect(buildChunkKey(md5, 1000, 1024)).not.toBe(
      buildChunkKey(md5, 2000, 1024)
    );
  });

  it("键字符全部落在服务端 sanitizeFileId 白名单内", () => {
    const key = buildChunkKey("d".repeat(32), 123456789, 987654321);
    expect(SANITIZE_FILE_ID(key)).toBe(key);
  });

  it("缺 size/chunkSize 时退化为纯 md5（兼容旧行为）", () => {
    expect(buildChunkKey("e".repeat(32), undefined, undefined)).toBe(
      "e".repeat(32)
    );
    expect(buildChunkKey("e".repeat(32), 0, 1024)).toBe("e".repeat(32));
  });

  it("md5 为空时返回空串（由调用方兜底）", () => {
    expect(buildChunkKey("", 100, 1024)).toBe("");
    expect(buildChunkKey(undefined, 100, 1024)).toBe("");
  });

  it("服务端 parseChunkKey 可反向解析（键契约一致）", () => {
    const key = buildChunkKey("f".repeat(32), 2048, 4096);
    const match = /^([a-f0-9]{32})_(\d+)_(\d+)$/.exec(key);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("f".repeat(32));
    expect(Number(match?.[2])).toBe(2048);
    expect(Number(match?.[3])).toBe(4096);
  });
});
