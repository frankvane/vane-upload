/**
 * VU-40：Worker 的 progress 消息频率由分片完成速度决定，可能远高于渲染帧率。
 * 这里把同一时间窗内的多条消息合并成「最后一条」再交给上层（store / 宿主回调），
 * 保证 UI 只按帧级更新，同时不丢失最终进度。
 *
 * 关键不变量：任务收尾时必须调用 flush()，否则最后一条（通常是 100%）会被丢掉。
 */

/** 合并窗口：16~100ms 之间，取 50ms ≈ 20fps，交互无感且足够省重渲染。 */
export const PROGRESS_THROTTLE_MS = 50;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface ProgressThrottle<T> {
  /** 收到一条进度：只保留最后一条，并在窗口结束时送出 */
  push: (detail: T) => void;
  /** 立即送出挂起的最后一条（任务结束 / 暂停 / 取消时调用） */
  flush: () => void;
  /** 丢弃挂起数据并取消调度（任务销毁时调用） */
  cancel: () => void;
}

export interface ProgressThrottleOptions {
  intervalMs?: number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancelScheduled?: (handle: TimerHandle) => void;
}

type Scheduler = (callback: () => void, delayMs: number) => TimerHandle;
type Canceller = (handle: TimerHandle) => void;

const defaultSchedule: Scheduler = (callback, delayMs) =>
  setTimeout(callback, delayMs);
const defaultCancel: Canceller = (handle) => clearTimeout(handle);

export const createProgressThrottle = <T>(
  emit: (detail: T) => void,
  {
    intervalMs = PROGRESS_THROTTLE_MS,
    schedule = defaultSchedule,
    cancelScheduled = defaultCancel,
  }: ProgressThrottleOptions = {}
): ProgressThrottle<T> => {
  let pending: T | undefined;
  let hasPending = false;
  let handle: TimerHandle | null = null;

  const cancel = () => {
    if (handle !== null) {
      cancelScheduled(handle);
      handle = null;
    }
    pending = undefined;
    hasPending = false;
  };

  const flush = () => {
    if (handle !== null) {
      cancelScheduled(handle);
      handle = null;
    }
    if (!hasPending) {
      return;
    }
    const detail = pending as T;
    pending = undefined;
    hasPending = false;
    emit(detail);
  };

  const push = (detail: T) => {
    pending = detail;
    hasPending = true;
    if (handle === null) {
      handle = schedule(() => {
        // timer 已触发，先清空句柄再 flush，避免对已触发 timer 重复 clear
        handle = null;
        flush();
      }, intervalMs);
    }
  };

  return { push, flush, cancel };
};
