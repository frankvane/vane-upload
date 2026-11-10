/**
 * T-29（报告 P2-11）：首字节延迟归因埋点。
 *
 * 背景：T-05 把「分片预热」从上传启动路径上摘掉后，实测 48MB 首字节只快了 151ms，
 * 而 1KB 文件的首字节仍有 ~750ms —— 说明大头是**与体积无关的固定开销**。
 * 在拿到分段耗时之前不做任何猜测性优化，因此这里先提供低成本埋点。
 *
 * 设计约束：
 * - **默认关闭**：只有 `globalThis.__VANE_PERF_TRACE__ === true` 时才打点。
 *   关闭态单次调用 = 一次属性读取，可常驻在选文件等冷路径上，不污染业务 timeline。
 * - **只打阶段点**：一次选文件 < 10 个 mark；分片、进度、重试等热路径一律不埋。
 * - 名称统一 `vane:` 前缀，便于 DevTools Performance 面板筛选与 e2e 读取。
 * - 任何异常都吞掉：埋点绝不能影响上传主流程。
 */
export const PERF_TRACE_FLAG = "__VANE_PERF_TRACE__";
export const PERF_MARK_PREFIX = "vane:";
/** 无法画到主线程 timeline 的明细（Worker 内部耗时等）挂在页面上的键名 */
export const PERF_DETAIL_KEY = "__VANE_PERF_TRACE_DETAILS__";

/** 埋点开关是否打开（供调用方跳过昂贵参数构造）。 */
export const isPerfTraceEnabled = (): boolean => {
  try {
    return (
      (globalThis as unknown as Record<string, unknown>)[PERF_TRACE_FLAG] === true
    );
  } catch {
    return false;
  }
};

/**
 * 打一个阶段点。`stage` 不带前缀，内部统一加 `vane:`。
 * 同名 mark 允许重复（`performance.getEntriesByName` 返回数组），归因脚本取首个。
 */
export const markPerf = (stage: string): void => {
  if (!isPerfTraceEnabled()) {
    return;
  }
  try {
    performance.mark(`${PERF_MARK_PREFIX}${stage}`);
  } catch {
    // performance 被禁用/不可用时静默降级
  }
};

/** 清空本轮之前的历史 mark 与明细，避免同页面多次选文件时归因脚本取到上一轮的点。 */
export const clearPerfMarks = (): void => {
  if (!isPerfTraceEnabled()) {
    return;
  }
  try {
    const names = performance
      .getEntriesByType("mark")
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(PERF_MARK_PREFIX));
    names.forEach((name) => performance.clearMarks(name));
    delete (globalThis as unknown as Record<string, unknown>)[PERF_DETAIL_KEY];
  } catch {
    // 同上：埋点失败不影响业务
  }
};

/**
 * 记录无法画到主线程 timeline 上的明细（如 Worker 内部耗时）。
 * 与 mark 一样默认关闭；归因脚本通过 `page.evaluate` 读取这个包。
 */
export const recordPerfDetail = (
  key: string,
  detail: Record<string, number | string>,
): void => {
  if (!isPerfTraceEnabled()) {
    return;
  }
  try {
    const host = globalThis as unknown as Record<string, unknown>;
    const bag = (host[PERF_DETAIL_KEY] as Record<string, unknown>) ?? {};
    bag[key] = detail;
    host[PERF_DETAIL_KEY] = bag;
  } catch {
    // 同上
  }
};
