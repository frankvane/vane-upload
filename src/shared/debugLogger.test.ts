import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDebugLog,
  configureDebug,
  debugError,
  debugLog,
  debugWarn,
  getDebugLog,
} from "./debugLogger";

/**
 * F7：调试日志限长（环形缓冲）。
 * 验证：上限裁剪 FIFO、快照拷贝、清空、silent 不缓冲、debug/error 在开启时入环。
 */
describe("debugLogger（F7：限长环形缓冲）", () => {
  beforeEach(() => {
    configureDebug({ silent: false, maxLogEntries: 500 });
    clearDebugLog();
  });

  afterEach(() => {
    configureDebug({ silent: true, maxLogEntries: 500 });
    clearDebugLog();
  });

  it("环形缓冲按上限裁剪，丢弃最旧条目（FIFO）", () => {
    configureDebug({ silent: false, maxLogEntries: 3 });
    clearDebugLog();
    debugLog("a");
    debugLog("b");
    debugLog("c");
    debugLog("d");
    debugLog("e");
    const log = getDebugLog();
    expect(log).toHaveLength(3);
    expect(log[0]).toContain("c");
    expect(log[1]).toContain("d");
    expect(log[2]).toContain("e");
  });

  it("getDebugLog 返回快照副本，外部修改不影响内部缓冲", () => {
    debugLog("inner");
    const snapshot = getDebugLog();
    snapshot[0] = "mutated-external";
    expect(getDebugLog()[0]).toContain("inner");
    expect(getDebugLog()[0]).not.toContain("mutated-external");
  });

  it("clearDebugLog 清空缓冲", () => {
    debugLog("x");
    expect(getDebugLog()).toHaveLength(1);
    clearDebugLog();
    expect(getDebugLog()).toHaveLength(0);
  });

  it("silent=true 时不缓冲（生产环境零内存负担）", () => {
    configureDebug({ silent: true });
    clearDebugLog();
    // 即便真实失败 debugError 也经 pushRing，silent 时同样不入环
    debugLog("debug-msg");
    debugWarn("warn-msg");
    debugError("error-msg");
    expect(getDebugLog()).toHaveLength(0);
  });

  it("silent=false 时 debug / error 均入环", () => {
    configureDebug({ silent: false, maxLogEntries: 500 });
    clearDebugLog();
    debugLog("d1");
    debugError("e1");
    const log = getDebugLog();
    expect(log.some((l) => l.includes("d1"))).toBe(true);
    expect(log.some((l) => l.includes("e1"))).toBe(true);
  });
});
