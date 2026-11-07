import { describe, expect, it } from "vitest";

import { buildQueueId } from "./fileId";

describe("buildQueueId（T2.2 队列 id 唯一性，P1-7）", () => {
  it("连续 1000 次生成无碰撞", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      ids.add(buildQueueId("a".repeat(32), 1024, 1700000000000));
    }
    expect(ids.size).toBe(1000);
  });

  it("同内容同参数的两条 id 也不同（覆盖旧版 md5 冲突）", () => {
    const first = buildQueueId("b".repeat(32), 2048, 1700000000000);
    const second = buildQueueId("b".repeat(32), 2048, 1700000000000);
    expect(first).not.toBe(second);
  });

  it("id 以 md5 开头，保留按内容检索的能力", () => {
    const md5 = "c".repeat(32);
    expect(buildQueueId(md5, 512, 0).startsWith(`${md5}_`)).toBe(true);
  });

  it("缺失参数时仍返回非空串", () => {
    expect(buildQueueId(undefined, undefined, undefined)).toMatch(/^_0_0_/);
    expect(buildQueueId("d".repeat(32), undefined, undefined)).toMatch(
      new RegExp(`^${"d".repeat(32)}_0_0_`)
    );
  });
});
