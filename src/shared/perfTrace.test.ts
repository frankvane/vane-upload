import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PERF_DETAIL_KEY,
  PERF_MARK_PREFIX,
  PERF_TRACE_FLAG,
  clearPerfMarks,
  isPerfTraceEnabled,
  markPerf,
  recordPerfDetail,
} from "./perfTrace";

/**
 * T-29 埋点的契约：默认零打扰（关闭时既不产 mark 也不写全局），
 * 打开后统一 `vane:` 前缀，且 clear 只清自己的东西 —— 不能碰业务/框架的 mark。
 */
const host = globalThis as unknown as Record<string, unknown>;

const markNames = (): string[] =>
  performance
    .getEntriesByType("mark")
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(PERF_MARK_PREFIX));

beforeEach(() => {
  delete host[PERF_TRACE_FLAG];
  delete host[PERF_DETAIL_KEY];
  performance.clearMarks();
});

afterEach(() => {
  delete host[PERF_TRACE_FLAG];
  delete host[PERF_DETAIL_KEY];
  performance.clearMarks();
});

describe("perfTrace（T-29 归因埋点）", () => {
  it("默认关闭：不产生任何 mark，也不写明细", () => {
    markPerf("change:enter");
    recordPerfDetail("prepareWorker", { boot: 1 });

    expect(isPerfTraceEnabled()).toBe(false);
    expect(markNames()).toEqual([]);
    expect(host[PERF_DETAIL_KEY]).toBeUndefined();
  });

  it("开关为 true 时打点，名称统一加 vane: 前缀", () => {
    host[PERF_TRACE_FLAG] = true;

    markPerf("change:enter");
    markPerf("queue:persisted");

    expect(markNames()).toEqual([
      `${PERF_MARK_PREFIX}change:enter`,
      `${PERF_MARK_PREFIX}queue:persisted`,
    ]);
  });

  it("非布尔真值不算开启（避免误配 \"1\" / 1 时静默埋点）", () => {
    host[PERF_TRACE_FLAG] = "1";
    expect(isPerfTraceEnabled()).toBe(false);

    host[PERF_TRACE_FLAG] = 1;
    expect(isPerfTraceEnabled()).toBe(false);

    host[PERF_TRACE_FLAG] = true;
    expect(isPerfTraceEnabled()).toBe(true);
  });

  it("recordPerfDetail 在开启时按 key 归并，不清掉其它 key", () => {
    host[PERF_TRACE_FLAG] = true;

    recordPerfDetail("prepareWorker", { boot: 12, hash: 3 });
    recordPerfDetail("someOtherStage", { cost: 7 });

    expect(host[PERF_DETAIL_KEY]).toEqual({
      prepareWorker: { boot: 12, hash: 3 },
      someOtherStage: { cost: 7 },
    });
  });

  it("clearPerfMarks 只清 vane: 前缀的 mark，并重置明细包", () => {
    host[PERF_TRACE_FLAG] = true;
    performance.mark("framework:boot");
    markPerf("change:enter");
    recordPerfDetail("prepareWorker", { boot: 1 });

    clearPerfMarks();

    expect(markNames()).toEqual([]);
    // 业务/框架自己的 mark 必须留着
    expect(performance.getEntriesByName("framework:boot")).toHaveLength(1);
    expect(host[PERF_DETAIL_KEY]).toBeUndefined();
  });

  it("关闭时 clearPerfMarks 不做事（不会误删他人 mark）", () => {
    performance.mark("framework:boot");
    markPerf("change:enter");

    clearPerfMarks();

    expect(performance.getEntriesByName("framework:boot")).toHaveLength(1);
  });
});
