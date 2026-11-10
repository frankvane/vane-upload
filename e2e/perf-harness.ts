import crypto from "crypto";
import type { Browser, Page } from "@playwright/test";

/**
 * 首字节测量的公共脚手架（T-29 归因与 T-16 预算共用）。
 *
 * 口径：把「选文件 → 首个 /api/file/instant」拆成页内 `performance.mark` 序列，
 * 所有时间统一换成 epoch ms 再做差（页面与 Node 同机同时钟，误差毫秒级）。
 * Worker 内部耗时（boot / hash）通过 `complete.timings` 回传，落在
 * `globalThis.__VANE_PERF_TRACE_DETAILS__.prepareWorker`。
 */

export const MB = 1024 * 1024;

export interface RunResult {
  /** mark 名 → epoch ms（同名取首个） */
  marks: Record<string, number>;
  /** 预处理 Worker 内部耗时 */
  details: { boot: number; waitForMessage: number; hash: number } | null;
  firstInstantAt: number | null;
  firstUploadAt: number | null;
}

/** 每次测量用全新 context：清空队列与 IndexedDB，避免被上一轮记录去重命中 */
export async function measureOnce(
  browser: Browser,
  baseURL: string,
  bytes: number,
  label: string,
  run: number,
): Promise<RunResult> {
  const context = await browser.newContext({ baseURL });
  const page: Page = await context.newPage();
  const consoleLines: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleLines.push(msg.text());
  });

  const net = { instant: 0, upload: 0 };

  // 只测「首个请求」，不打真后端：全部 /api 直接 200 空对象，
  // 让上传流程快速失败退出，避免 48MB 真的落盘。
  await page.route("**/api/file/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/instant") && net.instant === 0) {
      net.instant = Date.now();
    }
    if (url.endsWith("/upload") && net.upload === 0) {
      net.upload = Date.now();
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
  });

  await page.addInitScript(() => {
    (globalThis as unknown as Record<string, unknown>).__VANE_PERF_TRACE__ = true;
  });

  await page.goto("/");
  const input = page.locator("#root input[type=file]");
  await input.waitFor({ state: "attached" });

  await input.setInputFiles({
    // 随机内容 + 每次不同的文件名：既避免命中上一轮记录的去重，也避免服务端秒传
    name: `perf-${label}-${run}-${Date.now()}.bin`,
    mimeType: "application/octet-stream",
    buffer: crypto.randomBytes(bytes),
  });

  const deadline = Date.now() + 60_000;
  while (net.instant === 0 && Date.now() < deadline) {
    await page.waitForTimeout(50);
  }

  const trace = await page.evaluate(() => {
    const origin = performance.timeOrigin;
    const marks: Record<string, number> = {};
    for (const entry of performance.getEntriesByType("mark")) {
      if (!entry.name.startsWith("vane:")) continue;
      const key = entry.name.slice("vane:".length);
      if (!(key in marks)) marks[key] = origin + entry.startTime;
    }
    const bag = (globalThis as unknown as Record<string, unknown>)[
      "__VANE_PERF_TRACE_DETAILS__"
    ] as Record<string, Record<string, number>> | undefined;
    return { marks, details: bag?.prepareWorker ?? null };
  });

  await context.close();

  if (net.instant === 0) {
    throw new Error(
      `[${label} run${run}] 60s 内未发出 /api/file/instant；console: ${consoleLines
        .slice(-3)
        .join(" | ")}`,
    );
  }

  return {
    marks: trace.marks,
    details: trace.details as RunResult["details"],
    firstInstantAt: net.instant || null,
    firstUploadAt: net.upload || null,
  };
}

/** 取一组测量里最省的一次 —— 抑制偶发 GC/调度抖动，比中位数更能反映"能力" */
export function bestOf(results: RunResult[]): RunResult {
  return results.reduce((best, current) => {
    const a = best.firstInstantAt ?? Number.POSITIVE_INFINITY;
    const b = current.firstInstantAt ?? Number.POSITIVE_INFINITY;
    return b < a ? current : best;
  });
}

export interface Breakdown {
  /** change → 首个网络请求 */
  total: number;
  /** 预处理 Worker 内哈希耗时 */
  hash: number;
  /** 自动上传合并窗口（queue:persisted → autoupload:timer-fired） */
  window: number;
  /** 扣掉哈希与合并窗口后的工程开销 */
  fixedOverhead: number;
}

/** 把一次测量折算成四个可用数字；缺 mark 时返回 NaN（由断言失败暴露） */
export function breakdown(run: RunResult): Breakdown {
  const start = run.marks["change:enter"];
  const persisted = run.marks["queue:persisted"];
  const fired = run.marks["autoupload:timer-fired"];
  const total =
    start !== undefined && run.firstInstantAt !== null
      ? run.firstInstantAt - start
      : Number.NaN;
  const window =
    persisted !== undefined && fired !== undefined
      ? fired - persisted
      : Number.NaN;
  const hash = run.details?.hash ?? Number.NaN;
  return {
    total,
    hash,
    window,
    fixedOverhead: total - hash - window,
  };
}
