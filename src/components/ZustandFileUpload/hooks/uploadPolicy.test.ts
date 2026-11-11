import { describe, it, expect } from "vitest";

import {
  applyBeforeEach,
  applyFinalized,
  applySettled,
  classifyUploadResult,
  createInitialBatchInfo,
  isUploadSuccessKind,
  withClearedCountdown,
  type UploadResultKind,
} from "./uploadPolicy";
import type { BatchInfo } from "../types/upload";

const baseBatch = (): BatchInfo => ({
  current: 1,
  total: 5,
  queued: 3,
  active: 1,
  completed: 1,
  failed: 0,
  retried: 0,
});

describe("createInitialBatchInfo", () => {
  it("用 total 构造初始批次，retried 默认 0", () => {
    const info = createInitialBatchInfo(10);
    expect(info).toEqual({
      current: 0,
      total: 10,
      queued: 10,
      active: 0,
      completed: 0,
      failed: 0,
      retried: 0,
    });
  });

  it("批量重试场景可传入 retried 作为初始值", () => {
    const info = createInitialBatchInfo(3, 2);
    expect(info.total).toBe(3);
    expect(info.queued).toBe(3);
    expect(info.retried).toBe(2);
  });
});

describe("withClearedCountdown", () => {
  it("prev 非空时清空 countdown 且保留其它字段", () => {
    const prev = { ...baseBatch(), countdown: 30 };
    const next = withClearedCountdown(prev);
    expect(next?.countdown).toBeUndefined();
    expect(next?.current).toBe(1);
    expect(next?.total).toBe(5);
  });

  it("prev 为 null 时返回 null", () => {
    expect(withClearedCountdown(null)).toBeNull();
  });
});

describe("applyBeforeEach", () => {
  it("入队一件：queued -1，active +1，其它不变", () => {
    const prev = baseBatch(); // queued=3, active=1
    const next = applyBeforeEach(prev)!;
    expect(next.queued).toBe(2);
    expect(next.active).toBe(2);
    expect(next.completed).toBe(1);
    expect(next.failed).toBe(0);
  });

  it("queued 已为 0 时不出现负数（Math.max 保护），active 仍 +1", () => {
    const prev = { ...baseBatch(), queued: 0 }; // active 仍为 1
    const next = applyBeforeEach(prev)!;
    expect(next.queued).toBe(0); // Math.max(0, 0-1) === 0
    expect(next.active).toBe(2); // 1 + 1
  });

  it("active 为 0 时 +1 后不为负（状态机入队语义）", () => {
    const prev = { ...baseBatch(), active: 0, queued: 2 };
    const next = applyBeforeEach(prev)!;
    expect(next.active).toBe(1);
    expect(next.queued).toBe(1);
  });

  it("prev 为 null 时返回 null", () => {
    expect(applyBeforeEach(null)).toBeNull();
  });
});

describe("applySettled", () => {
  it("成功结算：current +1，active -1，completed +1，failed 不变", () => {
    const prev = baseBatch(); // current=1, active=1, completed=1, failed=0
    const next = applySettled(prev, true)!;
    expect(next.current).toBe(2);
    expect(next.active).toBe(0);
    expect(next.completed).toBe(2);
    expect(next.failed).toBe(0);
  });

  it("失败结算：current +1，active -1，completed 不变，failed +1", () => {
    const prev = baseBatch();
    const next = applySettled(prev, false)!;
    expect(next.current).toBe(2);
    expect(next.active).toBe(0);
    expect(next.completed).toBe(1);
    expect(next.failed).toBe(1);
  });

  it("active 已为 0 时不出现负数（Math.max 保护）", () => {
    const prev = { ...baseBatch(), active: 0 };
    const next = applySettled(prev, true)!;
    expect(next.active).toBe(0);
  });

  it("prev 为 null 时返回 null", () => {
    expect(applySettled(null, true)).toBeNull();
  });
});

describe("applyFinalized", () => {
  it("prev 非空：落定 completed/failed，清零队列与活动，autoCleanup 时带 countdown", () => {
    const prev = baseBatch();
    const next = applyFinalized(
      prev,
      { successCount: 4, failedCount: 1 },
      5,
      { autoCleanup: true, cleanupDelay: 42 }
    )!;
    expect(next.current).toBe(5);
    expect(next.total).toBe(5);
    expect(next.queued).toBe(0);
    expect(next.active).toBe(0);
    expect(next.completed).toBe(4);
    expect(next.failed).toBe(1);
    expect(next.countdown).toBe(42);
  });

  it("autoCleanup=false 时 countdown 为 undefined", () => {
    const next = applyFinalized(
      baseBatch(),
      { successCount: 3, failedCount: 2 },
      5,
      { autoCleanup: false, cleanupDelay: 42 }
    )!;
    expect(next.countdown).toBeUndefined();
  });

  it("prev 为 null：以 total 与 summary 构造完整批次", () => {
    const next = applyFinalized(
      null,
      { successCount: 5, failedCount: 0 },
      5,
      { autoCleanup: false, cleanupDelay: 10 }
    )!;
    expect(next).toEqual({
      current: 5,
      total: 5,
      queued: 0,
      active: 0,
      completed: 5,
      failed: 0,
      retried: 0,
      countdown: 10,
    });
  });
});

describe("classifyUploadResult", () => {
  it("优先级：cancelled > 其余", () => {
    const kind: UploadResultKind = classifyUploadResult({
      cancelled: true,
      success: true,
      errorMessage: "x",
    });
    expect(kind).toEqual({ kind: "cancelled" });
  });

  it("paused 且带 pausedChunks", () => {
    const kind = classifyUploadResult({ paused: true, pausedChunks: 3 });
    expect(kind).toEqual({ kind: "paused", pausedChunks: 3 });
  });

  it("paused 但不带 pausedChunks", () => {
    const kind = classifyUploadResult({ paused: true });
    expect(kind).toEqual({ kind: "paused" });
  });

  it("success 且 non-skipped", () => {
    const kind = classifyUploadResult({ success: true });
    expect(kind).toEqual({ kind: "success", skipped: false });
  });

  it("success 且 skipped（秒传）", () => {
    const kind = classifyUploadResult({ success: true, skipped: true });
    expect(kind).toEqual({ kind: "success", skipped: true });
  });

  it("失败且无 errorMessage 时回退默认文案", () => {
    const kind = classifyUploadResult({});
    expect(kind).toEqual({ kind: "error", message: "上传失败" });
  });

  it("失败且带 errorMessage", () => {
    const kind = classifyUploadResult({ errorMessage: "网络断开" });
    expect(kind).toEqual({ kind: "error", message: "网络断开" });
  });
});

describe("isUploadSuccessKind", () => {
  it("success 分支返回 true", () => {
    expect(isUploadSuccessKind({ kind: "success", skipped: true })).toBe(true);
  });

  it("cancelled / paused / error 分支返回 false", () => {
    expect(isUploadSuccessKind({ kind: "cancelled" })).toBe(false);
    expect(isUploadSuccessKind({ kind: "paused" })).toBe(false);
    expect(isUploadSuccessKind({ kind: "error", message: "x" })).toBe(false);
  });
});
