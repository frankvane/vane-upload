import { describe, expect, it } from "vitest";
import { runConcurrentQueue } from "./uploadOrchestrator";

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe("runConcurrentQueue", () => {
  it("processes all items and returns success/failure summary", async () => {
    const items = [1, 2, 3, 4];
    let running = 0;
    let maxRunning = 0;

    const summary = await runConcurrentQueue({
      items,
      concurrency: 2,
      beforeEach: async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
      },
      task: async (item) => {
        await wait(5);
        return item % 2 === 0;
      },
      onSettled: () => {
        running = Math.max(0, running - 1);
      },
    });

    expect(summary).toEqual({
      successCount: 2,
      failedCount: 2,
      skippedCount: 0,
    });
    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it("stops scheduling when shouldStop is triggered", async () => {
    let executed = 0;

    const summary = await runConcurrentQueue({
      items: [1, 2, 3],
      concurrency: 1,
      shouldStop: () => executed >= 1,
      task: async () => {
        executed += 1;
        return true;
      },
    });

    expect(executed).toBe(1);
    expect(summary).toEqual({
      successCount: 1,
      failedCount: 0,
      skippedCount: 0,
    });
  });

  it("passes aligned index into beforeEach and onSettled", async () => {
    const beforeIndexes: number[] = [];
    const settledIndexes: number[] = [];

    await runConcurrentQueue({
      items: ["a", "b", "c"],
      concurrency: 1,
      beforeEach: async (_item, index) => {
        beforeIndexes.push(index);
      },
      task: async () => true,
      onSettled: ({ index }) => {
        settledIndexes.push(index);
      },
    });

    expect(beforeIndexes).toEqual([0, 1, 2]);
    expect(settledIndexes).toEqual([0, 1, 2]);
  });

  it("T-14：beforeEach 返回 \"skip\" 时不执行任务，也不计失败", async () => {
    const items = ["keep", "gone", "gone-2"];
    const executed: string[] = [];
    const settled: Array<{ item: string; skipped?: boolean }> = [];

    const summary = await runConcurrentQueue({
      items,
      concurrency: 1,
      beforeEach: async (item) => (item.startsWith("gone") ? "skip" : undefined),
      task: async (item) => {
        executed.push(item);
        return true;
      },
      onSettled: ({ item, skipped }) => {
        settled.push({ item, skipped });
      },
    });

    // 跳过的两件根本没跑
    expect(executed).toEqual(["keep"]);
    expect(summary).toEqual({
      successCount: 1,
      failedCount: 0,
      skippedCount: 2,
    });
    // 仍然回调 onSettled，让上层把批次计数推进到位
    expect(settled).toEqual([
      { item: "keep", skipped: undefined },
      { item: "gone", skipped: true },
      { item: "gone-2", skipped: true },
    ]);
  });

  describe("T-33 宿主回调 / 任务异常不拖垮整批", () => {
    it("beforeEach 抛异常：该件计失败、异常透传给 onSettled，其余任务仍执行", async () => {
      const executed: number[] = [];
      const errors: unknown[] = [];

      const summary = await runConcurrentQueue({
        items: [1, 2, 3],
        concurrency: 1,
        beforeEach: async (item) => {
          if (item === 2) throw new Error("beforeEach boom");
        },
        task: async (item) => {
          executed.push(item);
          return true;
        },
        onSettled: ({ error }) => {
          if (error) errors.push(error);
        },
      });

      expect(executed).toEqual([1, 3]);
      expect(errors).toHaveLength(1);
      expect(summary).toEqual({
        successCount: 2,
        failedCount: 1,
        skippedCount: 0,
      });
    });

    it("onSettled 抛异常：批次仍结算完且不向外抛", async () => {
      const summary = await runConcurrentQueue({
        items: [1, 2],
        concurrency: 1,
        task: async () => true,
        onSettled: async () => {
          throw new Error("onSettled boom");
        },
      });

      expect(summary).toEqual({
        successCount: 2,
        failedCount: 0,
        skippedCount: 0,
      });
    });

    it("task 抛异常：异常透传给 onSettled，仍计失败但不中断后续任务", async () => {
      const errors: string[] = [];

      const summary = await runConcurrentQueue({
        items: [1, 2],
        concurrency: 1,
        task: async (item) => {
          if (item === 1) throw new Error("task boom");
          return true;
        },
        onSettled: ({ error }) => {
          if (error) errors.push(String((error as Error).message));
        },
      });

      expect(errors).toEqual(["task boom"]);
      expect(summary).toEqual({
        successCount: 1,
        failedCount: 1,
        skippedCount: 0,
      });
    });
  });

  describe("T-36 非法并发数回落", () => {
    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      "concurrency=%s 时任务仍全部执行",
      async (concurrency) => {
        let executed = 0;

        const summary = await runConcurrentQueue({
          items: [1, 2, 3],
          concurrency,
          task: async () => {
            executed += 1;
            return true;
          },
        });

        expect(executed).toBe(3);
        expect(summary.successCount).toBe(3);
      }
    );
  });
});
