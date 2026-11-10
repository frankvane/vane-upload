import { test } from "@playwright/test";

import { MB, measureOnce, type RunResult } from "./perf-harness";

/**
 * 首字节固定开销归因（**测量脚本，默认不参与 e2e 回归**）。
 *
 * 用法：
 *   PERF_TRACE=1 npx playwright test e2e/perf.first-byte.spec.ts                    # dev 模式
 *   npm run build:demo && \
 *     PERF_PROD=1 PERF_TRACE=1 npx playwright test e2e/perf.first-byte.spec.ts       # 生产构建
 *
 * 把「change → 首个网络请求」拆成 8 段，用实测数字定位与体积无关的固定开销，
 * 避免凭直觉优化 Worker 哈希。回归护栏见 `first-byte.budget.spec.ts`。
 */

const SIZES = [
  { label: "1KB", bytes: 1024 },
  { label: "8MB", bytes: 8 * MB },
  { label: "48MB", bytes: 48 * MB },
];

const RUNS = Number(process.env.PERF_RUNS || 3);

/** 阶段序列：每一段的起点/终点 mark 名（`@network` 表示首个网络请求） */
const STAGES: { label: string; from: string; to: string }[] = [
  { label: "① change→校验完成", from: "change:enter", to: "change:validated" },
  { label: "② 校验→建预处理Worker", from: "change:validated", to: "prepare:worker-created" },
  { label: "③ Worker启动+哈希首片", from: "prepare:worker-created", to: "prepare:first-progress" },
  { label: "④ 哈希剩余→complete", from: "prepare:first-progress", to: "prepare:complete" },
  { label: "⑤ 持久化+刷新队列", from: "prepare:complete", to: "queue:persisted" },
  { label: "⑥ 自动上传合并窗口", from: "queue:persisted", to: "autoupload:timer-fired" },
  { label: "⑦ 派发→上传Worker启动", from: "autoupload:timer-fired", to: "upload:dispatch" },
  { label: "⑧ 派发→首个网络请求", from: "upload:dispatch", to: "@network" },
];

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

const segment = (run: RunResult, stage: { from: string; to: string }): number => {
  const from = run.marks[stage.from];
  const to =
    stage.to === "@network" ? (run.firstInstantAt ?? Number.NaN) : run.marks[stage.to];
  if (from === undefined || to === undefined || Number.isNaN(to)) return Number.NaN;
  return Math.round(to - from);
};

test.describe("T-29 首字节延迟归因", () => {
  test.describe.configure({ timeout: 300_000 });

  test("各阶段耗时实测表", async ({ browser, baseURL }) => {
    test.skip(
      process.env.PERF_TRACE !== "1",
      "测量脚本：需 PERF_TRACE=1 显式开启（默认不参与回归）",
    );
    if (!baseURL) throw new Error("缺少 baseURL");

    const mode = process.env.PERF_PROD === "1" ? "生产构建（dist/demo）" : "dev";
    const push = (line: string) => console.log(line);

    push(`\n=== T-29 首字节归因 · ${mode} · 每体积 ${RUNS} 次取中位数 ===`);

    for (const size of SIZES) {
      const results: RunResult[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        results.push(await measureOnce(browser, baseURL, size.bytes, size.label, run));
      }

      push(`\n--- ${size.label} ---`);
      for (const stage of STAGES) {
        const values = results.map((result) => segment(result, stage));
        const valid = values.filter((value) => !Number.isNaN(value));
        if (valid.length === 0) {
          push(`${stage.label}: 无数据`);
          continue;
        }
        push(`${stage.label}: 中位 ${median(valid)}ms  (${valid.join(" / ")}ms)`);
      }

      const totals = results.map((result) =>
        segment(result, { from: "change:enter", to: "@network" }),
      );
      const validTotals = totals.filter((value) => !Number.isNaN(value));
      push(
        `合计 change→首个请求: 中位 ${median(validTotals)}ms  (${validTotals.join(" / ")}ms)`,
      );

      const worker = results
        .map((result) => result.details)
        .filter((detail): detail is NonNullable<typeof detail> => Boolean(detail));
      if (worker.length > 0) {
        push(
          `[预处理 Worker 内部] boot ${worker.map((d) => d.boot).join("/")}ms · ` +
            `waitForMessage ${worker.map((d) => d.waitForMessage).join("/")}ms · ` +
            `hash ${worker.map((d) => d.hash).join("/")}ms`,
        );
      }
    }
  });
});
