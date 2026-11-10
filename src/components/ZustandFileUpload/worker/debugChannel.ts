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

/** VU-05：日志 data 的兜底脱敏——headers 按敏感键置换，字符串值洗掉裸 token。 */
const sanitizeDebugData = (
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!data) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.toLowerCase() === "headers" && value && typeof value === "object") {
      safe[key] = redactHeaders(value as Record<string, string>);
    } else if (typeof value === "string") {
      safe[key] = scrubLogText(value);
    } else {
      safe[key] = value;
    }
  }
  return safe;
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
