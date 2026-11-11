/**
 * Worker 调试日志通道（T-17：从 uploadWorker.ts 抽出）。
 *
 * 节流状态与开关收在闭包里，避免模块级可变全局；出站消息统一过脱敏，
 * 任何调用点都不必自己记着洗 token。
 */
import { debugLog } from "../../../shared/debugLogger";
import { redactHeaders, scrubLogText } from "../../../shared/redact";

export type WorkerDebug = (
  message: string,
  data?: Record<string, unknown>,
  urgent?: boolean,
) => void;

export interface DebugChannel {
  debug: WorkerDebug;
  setEnabled: (enabled: boolean) => void;
}

/** 只递归 plain object / 数组；File、Blob、Date 等保持原样，避免展开出无意义结构。 */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const MAX_SANITIZE_DEPTH = 4;

const sanitizeValue = (value: unknown, depth: number): unknown => {
  if (typeof value === "string") return scrubLogText(value);
  if (depth >= MAX_SANITIZE_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  if (!isPlainObject(value)) return value;
  const safe: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key.toLowerCase() === "headers" && nested && typeof nested === "object") {
      safe[key] = redactHeaders(nested as Record<string, string>);
    } else {
      safe[key] = sanitizeValue(nested, depth + 1);
    }
  }
  return safe;
};

/**
 * VU-05 / T-74：日志 data 的兜底脱敏——headers 按敏感键置换，
 * 字符串与嵌套对象递归洗掉裸 token（旧实现非字符串值原样透传，
 * 一旦调用点误塞整个 event.data 就会把 authHeaders 写进出站日志）。
 */
const sanitizeDebugData = (
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!data) return undefined;
  return sanitizeValue(data, 0) as Record<string, unknown>;
};

export const createDebugChannel = (
  postMessage: (message: unknown) => void,
): DebugChannel => {
  let enabled = false;
  let lastRoutineDebugAt = 0;
  const THROTTLE_MS = 200;

  /** @param urgent 紧急日志（失败/重试/超时/取消）不受节流限制；高频常规日志按 200ms 节流。 */
  const debug: WorkerDebug = (message, data, urgent = false) => {
    if (!enabled) return;

    const now = Date.now();
    if (!urgent && now - lastRoutineDebugAt < THROTTLE_MS) return;
    if (!urgent) lastRoutineDebugAt = now;

    // VU-05 纵深防御：调用点之外再统一洗一次，任何出站日志都不带明文凭据。
    const safeMessage = scrubLogText(message);
    const safeData = sanitizeDebugData(data);
    debugLog(`[UploadWorker] ${safeMessage}`, safeData || "");
    postMessage({ type: "debug", message: safeMessage, data: safeData });
  };

  return {
    debug,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
};
