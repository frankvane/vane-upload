import { describe, expect, it, vi } from "vitest";
import { mapWithConcurrency, runCursorPool } from "./concurrency";

/** 让出两个微任务，使同一轮的 runner 都能进入临界区，从而观察真实并发峰值。 */
const yieldTwice = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("runCursorPool（VU-49 游标式并发池）", () => {
  it("runner 数量等于并发上限，且每个索引只被领取一次", async () => {
    let active = 0;
    let peak = 0;
    let cursor = 0;
    const seen: number[] = [];

    const summary = await runCursorPool({
      next: () => (cursor < 12 ? cursor++ : undefined),
      concurrency: 3,
      task: async (index) => {
        active += 1;
        peak = Math.max(peak, active);
        seen.push(index);
        await yieldTwice();
        active -= 1;
      },
    });

    expect(peak).toBe(3);
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    expect(seen.slice().sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i),
    );
    expect(summary).toEqual({ completed: 12, failed: 0, failedIndices: [] });
  });

  it("游标惰性：next 只在 runner 空闲时被调用，不预先物化全部索引", async () => {
    let cursor = 0;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pool = runCursorPool({
      next: () => {
        calls += 1;
        return cursor < 5000 ? cursor++ : undefined;
      },
      concurrency: 2,
      task: async () => {
        // 前两个任务阻塞，模拟数千分片场景下的在途 IO
        if (calls <= 2) await gate;
      },
    });

    await yieldTwice();
    // 5000 个索引没有在启动时被一次性取出
    expect(calls).toBeLessThanOrEqual(2 + 4);

    release();
    const summary = await pool;
    expect(summary.completed).toBe(5000);
    expect(calls).toBeGreaterThanOrEqual(5000);
  });

  it("单任务失败不中断其余任务，失败索引统一记录", async () => {
    let cursor = 0;
    const onFailure = vi.fn();
    const summary = await runCursorPool({
      next: () => (cursor < 6 ? cursor++ : undefined),
      concurrency: 2,
      task: async (index) => {
        await yieldTwice();
        if (index === 2 || index === 4) throw new Error(`fail-${index}`);
      },
      onFailure,
    });

    expect(summary.completed).toBe(4);
    expect(summary.failed).toBe(2);
    expect(summary.failedIndices.slice().sort()).toEqual([2, 4]);
    expect(onFailure).toHaveBeenCalledTimes(2);
  });

  it("shouldStop 为真时立即停止领取新任务", async () => {
    let cursor = 0;
    const task = vi.fn(async () => undefined);
    const summary = await runCursorPool({
      next: () => (cursor < 100 ? cursor++ : undefined),
      concurrency: 1,
      task,
      shouldStop: () => cursor >= 3,
    });

    expect(task).toHaveBeenCalledTimes(3);
    expect(summary.completed).toBe(3);
  });

  it("并发数非法值（0 / NaN）时退化为 1，不会死锁", async () => {
    let cursor = 0;
    const zero = await runCursorPool({
      next: () => (cursor < 3 ? cursor++ : undefined),
      concurrency: 0,
      task: async () => undefined,
    });
    expect(zero.completed).toBe(3);

    cursor = 0;
    const nan = await runCursorPool({
      next: () => (cursor < 3 ? cursor++ : undefined),
      concurrency: Number.NaN,
      task: async () => undefined,
    });
    expect(nan.completed).toBe(3);
  });
});

describe("mapWithConcurrency（VU-43 哈希并发池）", () => {
  it("结果按原 index 归并，即使任务完成顺序乱序", async () => {
    let active = 0;
    let peak = 0;
    const items = ["a", "b", "c", "d", "e", "f"];

    const results = await mapWithConcurrency(items, 2, async (item, index) => {
      active += 1;
      peak = Math.max(peak, active);
      // 让偶数项更慢，制造乱序完成
      await yieldTwice();
      if (index % 2 === 0) await yieldTwice();
      active -= 1;
      return `${item}:${index}`;
    });

    expect(peak).toBe(2);
    expect(results).toEqual([
      "a:0",
      "b:1",
      "c:2",
      "d:3",
      "e:4",
      "f:5",
    ]);
  });

  it("单条返回 undefined 表示跳过，其余结果不受影响", async () => {
    const results = await mapWithConcurrency(
      [1, 2, 3],
      2,
      async (value) => (value === 2 ? undefined : value * 10),
    );
    expect(results).toEqual([10, undefined, 30]);
  });

  it("空数组不启动任何 runner", async () => {
    const task = vi.fn(async (value: number) => value);
    const results = await mapWithConcurrency([], 4, task);
    expect(results).toEqual([]);
    expect(task).not.toHaveBeenCalled();
  });
});
