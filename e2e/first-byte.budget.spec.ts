import { expect, test } from "@playwright/test";

import { MB, bestOf, breakdown, measureOnce, type RunResult } from "./perf-harness";

/**
 * 首字节延迟预算：守住「上传启动链路与文件大小无关」和「固定开销不膨胀」。
 *
 * 首字节 = 全量哈希 + 自动上传合并窗口 + 工程固定开销。哈希随体积线性增长，
 * 合并窗口是产品设计（默认 120ms，可由 autoUploadDelay 配置），两者都不该被
 * 算进「启动链路是否劣化」。因此断言只看扣掉这两项之后的固定开销：
 *
 *  ① 8MB → 48MB 的固定开销增量 ≤ 100ms
 *     哨兵：任何「上传启动后还要按文件大小付一次代价」的回退都会变红
 *     （启动时整文件读入 / 整文件校验 / 把哈希搬回主线程）。
 *  ② 1KB 的固定开销总量 ≤ 500ms
 *     哨兵：新增固定等待、Worker 启动劣化、IDB 持久化变慢。
 *
 * 阈值取实测的 2–2.5 倍，留足沙箱抖动余量。
 * 已知盲区：预热成本若小于合并窗口会被窗口吸收，本用例测不出来；
 * 「预热不得卡在关键路径」由 primeChunkCache 永不 settle 仍能上传的单测守护。
 */

const SMALL = 8 * MB;
const LARGE = 48 * MB;
/** 每个体积跑 2 次取最优：抑制偶发 GC/调度抖动，比中位数更反映"能力" */
const RUNS = 2;

const FIXED_OVERHEAD_INCREMENT_BUDGET_MS = 100;
const FIXED_OVERHEAD_BUDGET_MS = 500;

const measureBest = async (
  browser: Parameters<typeof measureOnce>[0],
  baseURL: string,
  bytes: number,
  label: string,
): Promise<RunResult> => {
  const results: RunResult[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    results.push(await measureOnce(browser, baseURL, bytes, label, run));
  }
  return bestOf(results);
};

test.describe("T-16 首字节延迟预算", () => {
  test.describe.configure({ timeout: 240_000 });

  test("启动链路不随体积劣化，固定开销不失控", async ({ browser, baseURL }) => {
    if (!baseURL) throw new Error("缺少 baseURL");

    const small = breakdown(
      await measureBest(browser, baseURL, SMALL, "8mb"),
    );
    const large = breakdown(
      await measureBest(browser, baseURL, LARGE, "48mb"),
    );
    const tiny = breakdown(
      await measureBest(browser, baseURL, 1024, "1kb"),
    );

    const report = [
      `1KB  : total ${Math.round(tiny.total)}ms = hash ${tiny.hash} + window ${Math.round(tiny.window)} + 固定开销 ${Math.round(tiny.fixedOverhead)}`,
      `8MB  : total ${Math.round(small.total)}ms = hash ${small.hash} + window ${Math.round(small.window)} + 固定开销 ${Math.round(small.fixedOverhead)}`,
      `48MB : total ${Math.round(large.total)}ms = hash ${large.hash} + window ${Math.round(large.window)} + 固定开销 ${Math.round(large.fixedOverhead)}`,
    ].join("\n");
    console.log(`\n[T-16 首字节预算]\n${report}\n`);

    // 前置：缺了任一 mark/hash 明细，breakdown 会给出 NaN —— 让断言直接失败，
    // 而不是被 NaN 比较静默吞掉（NaN <= x 恒为 false，实际会失败，但信息不明确）。
    for (const [name, item] of [
      ["1KB", tiny],
      ["8MB", small],
      ["48MB", large],
    ] as const) {
      expect(
        Number.isFinite(item.total) && Number.isFinite(item.hash) && Number.isFinite(item.window),
        `${name} 的分段数据不完整（total=${item.total} hash=${item.hash} window=${item.window}），` +
          `埋点可能被移除或 mark 名被改动：${report}`,
      ).toBe(true);
    }

    // 合并窗口默认 120ms、可由 autoUploadDelay 配置；这里只确认延时存在且有上界，
    // 不锁死具体值（宿主调整 delay 不应让本用例失效）。
    expect(tiny.window, `自动上传合并窗口异常：${report}`).toBeGreaterThan(0);
    expect(tiny.window, `自动上传合并窗口异常：${report}`).toBeLessThan(1000);

    const nonHashSmall = small.total - small.hash;
    const nonHashLarge = large.total - large.hash;
    const nonHashIncrement = nonHashLarge - nonHashSmall;
    // 关键指标：扣掉哈希与合并窗口后的「启动链路开销」随体积的增量。
    // 基线应 ≈0 —— 上传启动与文件大小无关才是 P1-2 的验收条件。
    const fixedIncrement = large.fixedOverhead - small.fixedOverhead;

    expect(
      fixedIncrement,
      `启动链路开销的体积增量 ${Math.round(fixedIncrement)}ms 超出 ${FIXED_OVERHEAD_INCREMENT_BUDGET_MS}ms 预算 ` +
        `（8MB 固定开销 ${Math.round(small.fixedOverhead)}ms → 48MB ${Math.round(large.fixedOverhead)}ms）—— ` +
        `说明「上传启动」又变成与文件大小相关了（典型回退：启动前 await 全量预热/整文件读入）。\n` +
        `参考：非哈希总耗时增量 ${Math.round(nonHashIncrement)}ms。\n${report}`,
    ).toBeLessThanOrEqual(FIXED_OVERHEAD_INCREMENT_BUDGET_MS);

    expect(
      tiny.fixedOverhead,
      `1KB 固定开销 ${Math.round(tiny.fixedOverhead)}ms 超出 ${FIXED_OVERHEAD_BUDGET_MS}ms 预算 —— ` +
        `说明「change → 首个请求」之间新增了与体积无关的等待（定时器/Worker 启动/持久化）。\n${report}`,
    ).toBeLessThanOrEqual(FIXED_OVERHEAD_BUDGET_MS);
  });
});
