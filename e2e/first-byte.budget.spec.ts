import { expect, test } from "@playwright/test";

import { MB, bestOf, breakdown, measureOnce, type RunResult } from "./perf-harness";

/**
 * T-16：首字节延迟预算（**回归用例，默认参与 e2e**）。
 *
 * 为什么不用「首字节 ≤ 2s」这种绝对值：T-29 实测 1KB 文件首字节就有 571–664ms，
 * 其中 508ms 是自动上传的合并窗口 —— 绝对值预算只会写成一条永远为真的断言。
 * 也不止用「8MB→48MB 的差值」：那 40MB 的全量 md5 本身就 ≈584ms，
 * 差值天花板被算法锁死，测不出「启动链路」是否劣化。
 *
 * 因此拆成两条互补的断言（都不受构建模式与哈希算法变化影响）：
 *
 *  ① **固定开销的体积相关增量** ≤ 100ms（8MB → 48MB）
 *     `固定开销 = 首字节 − 哈希耗时 − 合并窗口`。它才是 P1-2 的哨兵：
 *     任何「上传启动后还要按文件大小付一次代价」的回退都会在这里爆
 *     （典型：启动时整文件读入/整文件校验/把哈希搬回主线程）。
 *     实测基线：dev ≈ −5~14ms（两条腿都在噪声内）。
 *
 *     注意它的**边界**：成本若低于合并窗口（500ms）会被窗口吸收，测不出来 ——
 *     见文末「已知盲区」，那条由单测守护。
 *
 *  ② **固定开销总量** ≤ 500ms（1KB，已扣掉实测的合并窗口与哈希）
 *     防「又加一个延时」「Worker 启动劣化」「IDB 持久化变慢」。
 *     实测基线：dev 146–223ms（抖动来自 IDB 与调度），prod ≈63ms。
 *
 * 阈值取实测的 2–2.5 倍：既留足沙箱抖动余量，又能在劣化 2 倍以上时变红。
 *
 * ⚠️ 已知盲区（实测发现，写下来免得后人误判"预算没生效"）：把
 * `void primeChunkCache` 改回 `await primeChunkCache` 时本预算**不会变红** ——
 * 48MB 预热只需 ≈144ms，而它落在 500ms 合并窗口内已被吸收（这也解释了
 * T-05 为何只省 151ms）。一旦 T-30 把窗口缩短到 0，本预算才会开始真正约束预热。
 * 「预热卡在关键路径」另有单测守护（`primeChunkCache` 永不 settle 仍能上传）。
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

    // 合并窗口是产品设计（T-30 待定），这里只验证它"存在"，不锁死具体值
    expect(tiny.window, `自动上传合并窗口异常：${report}`).toBeGreaterThan(100);

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
