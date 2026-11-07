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
});
