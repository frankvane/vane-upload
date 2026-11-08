import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProgressThrottle,
  PROGRESS_THROTTLE_MS,
} from "./progressThrottle";

interface Detail {
  progress: number;
}

describe("VU-40 progress 节流器", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("同一窗口内的多条进度只送出最后一条", () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle<Detail>(emit);

    for (let i = 1; i <= 10; i += 1) {
      throttle.push({ progress: i * 10 });
    }
    expect(emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(PROGRESS_THROTTLE_MS);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ progress: 100 });
  });

  it("flush 立即送出挂起进度，并取消后续重复送出", () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle<Detail>(emit);

    throttle.push({ progress: 30 });
    throttle.flush();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ progress: 30 });

    vi.advanceTimersByTime(PROGRESS_THROTTLE_MS * 3);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("cancel 丢弃挂起数据，窗口结束后不送出", () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle<Detail>(emit);

    throttle.push({ progress: 55 });
    throttle.cancel();
    vi.advanceTimersByTime(PROGRESS_THROTTLE_MS * 3);

    expect(emit).not.toHaveBeenCalled();
  });

  it("跨窗口的进度分别送出，且窗口结束后可继续合并", () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle<Detail>(emit);

    throttle.push({ progress: 10 });
    vi.advanceTimersByTime(PROGRESS_THROTTLE_MS);
    pushSecondWindow(throttle);

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls).toEqual([
      [{ progress: 10 }],
      [{ progress: 99 }],
    ]);
  });

  it("自定义 intervalMs 生效", () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle<Detail>(emit, { intervalMs: 16 });

    throttle.push({ progress: 1 });
    vi.advanceTimersByTime(15);
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

function pushSecondWindow(throttle: {
  push: (d: Detail) => void;
  flush: () => void;
}) {
  throttle.push({ progress: 20 });
  throttle.push({ progress: 99 });
  vi.advanceTimersByTime(PROGRESS_THROTTLE_MS);
  throttle.flush();
}
