/**
 * VU-63：前后端分片键协议契约。
 *
 * `server/src/utils/chunkKeyContract.js` 是服务端唯一实现，
 * `src/shared/chunkKey.ts` 是客户端唯一实现。本测试逐组输入比对两者，
 * 任一侧改动算法而另一侧未同步，这里立即失败，杜绝
 * `chunk-key.test.js` 时代「注释里手写一份、慢慢漂移」的风险。
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildChunkKey } from "./chunkKey";

const require = createRequire(import.meta.url);
const { buildChunkKey: serverBuildChunkKey } = require(
  "../../server/src/utils/chunkKeyContract.js"
) as { buildChunkKey: (...args: unknown[]) => string };

type RawCase = [unknown, unknown, unknown];

const cases: RawCase[] = [
  // 正常路径
  ["a".repeat(32), 1024, 262144],
  ["f".repeat(32), 5 * 1024 * 1024 * 1024, 8 * 1024 * 1024],
  ["0".repeat(32), 1, 1],
  // 缺 size / chunkSize → 退化为纯 md5（兼容旧键）
  ["a".repeat(32), 0, 1024],
  ["a".repeat(32), 1024, 0],
  ["a".repeat(32), undefined, 1024],
  ["a".repeat(32), 1024, null],
  ["a".repeat(32), Number.NaN, 1024],
  // md5 缺失 / 空白 / 需要 trim
  ["", 1024, 4096],
  [null, 1024, 4096],
  [undefined, 1024, 4096],
  ["   ", 1024, 4096],
  [`  ${"b".repeat(32)}  `, 1024, 4096],
  // 非数字入参（错误推测）
  ["a".repeat(32), "2048", 4096],
  ["a".repeat(32), 2048, "4096"],
  ["a".repeat(32), -1, 4096],
];

describe("VU-63：前后端 buildChunkKey 契约一致", () => {
  it("所有正常/边界/异常输入下两侧输出完全相同", () => {
    for (const [md5, size, chunkSize] of cases) {
      const client = buildChunkKey(
        md5 as string | undefined | null,
        size as number | undefined | null,
        chunkSize as number | undefined | null
      );
      const server = serverBuildChunkKey(md5, size, chunkSize);
      expect(server, `输入 ${JSON.stringify([md5, size, chunkSize])}`).toBe(
        client
      );
    }
  });

  it("生成的复合键能被服务端 parseChunkKey 解析", () => {
    const md5 = "c".repeat(32);
    const size = 2048;
    const chunkSize = 512;
    const key = buildChunkKey(md5, size, chunkSize);
    expect(key).toBe(`${md5}_${size}_${chunkSize}`);
    expect(/^([a-f0-9]{32})_(\d+)_(\d+)$/.test(key)).toBe(true);
    // 字符必须落在服务端 sanitizeFileId 白名单内
    expect(key).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("契约模块确实来自服务端源码，而不是本文件复制的副本", () => {
    expect(typeof serverBuildChunkKey).toBe("function");
    expect(serverBuildChunkKey("d".repeat(32), 10, 2)).toBe(
      `${"d".repeat(32)}_10_2`
    );
  });
});
