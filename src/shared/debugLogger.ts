/**
 * 可关闭的调试日志（库内部统一出口）。
 *
 * 库默认 silent=true：仅真实失败以 console.error 透出，避免生产环境噪声；
 * 调试/重试提示（warn/debug）默认静默。消费方排查时调用
 * `configureDebug({ silent: false })` 即可打开全部日志。
 *
 * 设计为纯模块、无 DOM 依赖，主线程与 Worker 均可安全 import。
 *
 * F7：打开调试后，所有日志条目进入**限长环形缓冲**（默认上限 500 条），避免长会话
 * 内存持续上涨；生产环境（silent=true）不缓冲（真实失败仍经 console.error 透出）。
 * 消费方可经 `getDebugLog()` 取出最近日志用于排障，`clearDebugLog()` 清空。
 */

let silent = true;
let maxLogEntries = 500;

/** 环形缓冲：仅调试开启时写入，超出上限丢弃最旧条目（F7） */
const ring: string[] = [];

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pushRing(level: string, args: unknown[]): void {
  // 生产（silent）不缓冲：避免任何内存增长；真实失败由 debugError 仍走 console.error
  if (silent) return;
  const msg = args.map(safeStringify).join(" ");
  ring.push(`[${level}][${new Date().toISOString()}] ${msg}`);
  // 限长：超出上限时丢弃最旧条目
  if (ring.length > maxLogEntries) {
    ring.splice(0, ring.length - maxLogEntries);
  }
}

export const configureDebug = (opt: {
  silent?: boolean;
  /** F7：环形缓冲上限（默认 500），仅调试开启时生效 */
  maxLogEntries?: number;
}): void => {
  if (opt.silent !== undefined) silent = opt.silent;
  if (typeof opt.maxLogEntries === "number" && opt.maxLogEntries > 0) {
    maxLogEntries = Math.floor(opt.maxLogEntries);
  }
};

export const debugLog = (...args: unknown[]): void => {
  if (!silent) console.debug("[rui-upload]", ...args);
  pushRing("debug", args);
};

export const debugWarn = (...args: unknown[]): void => {
  if (!silent) console.warn("[rui-upload]", ...args);
  pushRing("warn", args);
};

// 真实失败始终记录，不受 silent 控制（与 console.error 原语义一致）。
// 注意：silent 时不入环形缓冲（生产内存零负担），仅调试开启时留痕。
export const debugError = (...args: unknown[]): void => {
  console.error("[rui-upload]", ...args);
  pushRing("error", args);
};

/** 取出最近调试日志的快照（拷贝），用于排障上报；silent 时为空数组。 */
export const getDebugLog = (): string[] => ring.slice();

/** 清空调试日志环形缓冲。 */
export const clearDebugLog = (): void => {
  ring.length = 0;
};
