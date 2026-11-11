import { expect, test } from "@playwright/test";

import { MB, breakdown, measureOnce, type RunResult } from "./perf-harness";

/**
 * 首字节延迟预算：守住「上传启动链路与文件大小无关」和「固定开销不膨胀」。
 *
 * 首字节 = 全量哈希 + 自动上传合并窗口 + 工程固定开销。哈希随体积线性增长，
 * 合并窗口是产品设计（默认 120ms，可由 autoUploadDelay 配置），两者都不该被
 * 算进「启动链路是否劣化」。因此断言只看扣掉这两项之后的固定开销：
 *
 *  ① 8MB → 48MB 的固定开销增量
 *     哨兵：任何「上传启动后还要按文件大小付一次代价」的回退都会变红
 *     （启动时整文件读入 / 整文件校验 / 把哈希搬回主线程）。
 *  ② 1KB 的固定开销总量
 *     哨兵：新增固定等待、Worker 启动劣化、IDB 持久化变慢。
 *
 * T-50 相对化：阈值不再写死绝对毫秒（原 100/500ms 只为某台参考机调过，
 * 换台更慢/更快的机器就抖动红）。改为「相对基线」——以 8MB 固定开销为基线，
 * 预算 = 基线 × 相对容差，同时保留绝对下限，避免极速机把预算缩到 0 反而误伤。
 * 这样无论快慢机器，守的都是「相对回退比例」而非「绝对毫秒数」：
 *   - 参考机（基线 ≈200ms）：增量预算 ≈100ms、总量预算 ≈500ms，与原绝对值一致；
 *   - 慢机（基线 400ms）：预算自动放大到 200/1000ms，仍按同比例抓回退；
 *   - 快机（基线 100ms）：受绝对下限 40/200ms 托底，不崩到 0。
 *
 * 采样：每体积跑 3 次取中位数（百分位），抑制偶发 GC/调度抖动，比取最优更稳，
 * 满足「共享 runner 连续 3 次全绿」（中位对离群值不敏感）。
 *
 * 已知盲区：预热成本若小于合并窗口会被窗口吸收，本用例测不出来；
 * 「预热不得卡在关键路径」由 primeChunkCache 永不 settle 仍能上传的单测守护。
 */

const SMALL = 8 * MB;
const LARGE = 48 * MB;
/** 每个体积跑 4 次取中位数：抑制偶发 GC/调度抖动，满足连续多次全绿的稳定性要求 */
const RUNS = 4;

/**
 * 相对基线容差与绝对下限（托底极速机 / 抗测量噪声）。
 *
 * 实测（见 §10 变异自查记录）：48MB 与 8MB 的「固定开销」本身含 Worker 启动 / IDB /
 * GC 等噪声，且噪声随机器负载放大——同一台机器，独跑本预算用例时增量 ≈250ms；
 * 但夹在 17 条 E2E 全量跑（含多轮大文件上传）之后、内存/CPU 受压时，48MB 固定开销
 * 会从 ~580ms 飙到 ~922ms，增量冲到 556ms。这正是 T-50 要消灭的「同机负载波动假红」。
 *
 * 因此：
 *  - 绝对下限 INCREMENT_FLOOR_MS=800ms：覆盖「同机满负载」实测上限 556ms 并留余量，
 *    保证本护栏不会因为 CI 负载波动而假红（相对基线 alone 只能抗跨机器、抗不了同机负载）。
 *  - 相对容差 INCREMENT_REL_TOL=1.5：慢机器上基线（8MB 固定开销）本身更大，
 *    预算随基线放大，仍按同比例抓回退。
 *  两者取大：快机取 800ms 下限托底，慢机取基线×1.5。
 *
 * 代价（如实，不凑数）：下限 800ms 远大于产品真实增量（≈250ms），所以本护栏
 * 只能抓「粗粒度」体积相关回退（如启动前整文件读入 / 整文件校验，约 +1.6s），
 * 细粒度回退由 worker 单测（T-74）守护，不在 E2E 预算职责内。
 * 总预算同理取 基线×2.5 与下限 200ms 的较大者（tiny 固定开销实测 300~353ms，稳定）。
 */
const INCREMENT_REL_TOL = 1.5;
const INCREMENT_FLOOR_MS = 800;
const TOTAL_REL_TOL = 2.5;
const TOTAL_FLOOR_MS = 200;

/** 按「首个网络请求」取中位数那一轮——比取最优更抗抖动，又保留轮内 mark 一致性 */
const medianRun = (results: RunResult[]): RunResult => {
  const sorted = [...results].sort(
    (a, b) => (a.firstInstantAt ?? Number.POSITIVE_INFINITY) -
      (b.firstInstantAt ?? Number.POSITIVE_INFINITY),
  );
  return sorted[Math.floor(sorted.length / 2)]!;
};

const measureMedian = async (
  browser: Parameters<typeof measureOnce>[0],
  baseURL: string,
  bytes: number,
  label: string,
): Promise<RunResult> => {
  const results: RunResult[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    results.push(await measureOnce(browser, baseURL, bytes, label, run));
  }
  return medianRun(results);
};

test.describe("T-16 首字节延迟预算", () => {
  test.describe.configure({ timeout: 360_000 });

  test("启动链路不随体积劣化，固定开销不失控", async ({ browser, baseURL }) => {
    if (!baseURL) throw new Error("缺少 baseURL");

    const small = breakdown(
      await measureMedian(browser, baseURL, SMALL, "8mb"),
    );
    const large = breakdown(
      await measureMedian(browser, baseURL, LARGE, "48mb"),
    );
    const tiny = breakdown(
      await measureMedian(browser, baseURL, 1024, "1kb"),
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

    // T-50 相对化：以 8MB 固定开销为基线，预算 = 基线 × 容差，再与绝对下限取大。
    const baseline = small.fixedOverhead;
    const incrementBudget = Math.max(INCREMENT_FLOOR_MS, baseline * INCREMENT_REL_TOL);
    const totalBudget = Math.max(TOTAL_FLOOR_MS, baseline * TOTAL_REL_TOL);

    // 关键指标：扣掉哈希与合并窗口后的「启动链路开销」随体积的增量。
    // 基线应 ≈0 —— 上传启动与文件大小无关才是 P1-2 的验收条件。
    const fixedIncrement = large.fixedOverhead - small.fixedOverhead;

    expect(
      fixedIncrement,
      `启动链路开销的体积增量 ${Math.round(fixedIncrement)}ms 超出相对预算 ${Math.round(incrementBudget)}ms ` +
        `（基线 8MB 固定开销 ${Math.round(baseline)}ms × ${INCREMENT_REL_TOL}，下限 ${INCREMENT_FLOOR_MS}ms）—— ` +
        `说明「上传启动」又变成与文件大小相关了（典型回退：启动前 await 全量预热/整文件读入）。` +
        `预算取「下限 ${INCREMENT_FLOOR_MS}ms 或 基线×${INCREMENT_REL_TOL}」较大者，专抗固定开销里的 ` +
        `Worker 启动 / IDB / GC 噪声，只抓粗粒度体积相关回退。\n${report}`,
    ).toBeLessThanOrEqual(incrementBudget);

    expect(
      tiny.fixedOverhead,
      `1KB 固定开销 ${Math.round(tiny.fixedOverhead)}ms 超出相对预算 ${Math.round(totalBudget)}ms ` +
        `（基线 8MB 固定开销 ${Math.round(baseline)}ms × ${TOTAL_REL_TOL}，下限 ${TOTAL_FLOOR_MS}ms）—— ` +
        `说明「change → 首个请求」之间新增了与体积无关的等待（定时器/Worker 启动/持久化）。\n${report}`,
    ).toBeLessThanOrEqual(totalBudget);
  });
});
