/**
 * 上传业务策略（纯函数）：状态聚合与状态机判别。
 *
 * 本文件不依赖 React、不持有 engine / worker / store 引用，亦不产生副作用，
 * 仅对 `BatchInfo` 与 worker 返回结果做纯变换。副作用（写 IndexedDB、
 * 释放文件引用、触发清理策略等）仍由编排层（useBatchUploaderController）负责。
 */

import type { BatchInfo, UploadFile } from "../types/upload";

/** 批次初始信息（retried 默认 0；批量重试场景可传 failedFiles.length）。 */
export function createInitialBatchInfo(total: number, retried = 0): BatchInfo {
  return {
    current: 0,
    total,
    queued: total,
    active: 0,
    completed: 0,
    failed: 0,
    retried,
  };
}

/** 关闭自动清理倒计时（autoCleanup=false 时用于清空 countdown 字段）。 */
export function withClearedCountdown(prev: BatchInfo | null): BatchInfo | null {
  if (!prev) {
    return null;
  }
  return { ...prev, countdown: undefined };
}

/** 入队一件：queued -1，active +1。 */
export function applyBeforeEach(prev: BatchInfo | null): BatchInfo | null {
  if (!prev) {
    return null;
  }
  return {
    ...prev,
    queued: Math.max(0, prev.queued - 1),
    active: prev.active + 1,
  };
}

/** 结算一件：current +1，active -1，按成功与否累加 completed/failed。 */
export function applySettled(
  prev: BatchInfo | null,
  success: boolean
): BatchInfo | null {
  if (!prev) {
    return null;
  }
  return {
    ...prev,
    current: prev.current + 1,
    active: Math.max(0, prev.active - 1),
    completed: success ? prev.completed + 1 : prev.completed,
    failed: success ? prev.failed : prev.failed + 1,
  };
}

/** 批次收尾：清零队列/活动，落定 completed/failed 与倒计时。 */
export function applyFinalized(
  prev: BatchInfo | null,
  summary: { successCount: number; failedCount: number },
  total: number,
  opts: { autoCleanup: boolean; cleanupDelay: number }
): BatchInfo | null {
  if (!prev) {
    return {
      current: total,
      total,
      queued: 0,
      active: 0,
      completed: summary.successCount,
      failed: summary.failedCount,
      retried: 0,
      countdown: opts.cleanupDelay,
    };
  }

  return {
    ...prev,
    current: total,
    total,
    queued: 0,
    active: 0,
    completed: summary.successCount,
    failed: summary.failedCount,
    countdown: opts.autoCleanup ? opts.cleanupDelay : undefined,
  };
}

/** worker 上传结果的结构化类型（与 engine.workerPool.runUploadTask 返回对齐）。 */
export interface UploadTaskResult {
  cancelled?: boolean;
  paused?: boolean;
  success?: boolean;
  skipped?: boolean;
  pausedChunks?: number;
  errorMessage?: string;
}

export type UploadResultKind =
  | { kind: "cancelled" }
  | { kind: "paused"; pausedChunks?: number }
  | { kind: "success"; skipped: boolean }
  | { kind: "error"; message: string };

/**
 * 将 worker 结果判别为状态机分支（纯函数）。
 * 取消 > 暂停 > 成功 > 失败 的优先级与编排层原链式 if 一致。
 */
export function classifyUploadResult(result: UploadTaskResult): UploadResultKind {
  if (result.cancelled) {
    return { kind: "cancelled" };
  }
  if (result.paused) {
    return result.pausedChunks
      ? { kind: "paused", pausedChunks: result.pausedChunks }
      : { kind: "paused" };
  }
  if (result.success) {
    return { kind: "success", skipped: Boolean(result.skipped) };
  }
  return { kind: "error", message: result.errorMessage ?? "上传失败" };
}

/** 上传成功判定：INSTANT（秒传）或 DONE。供编排层写状态/释放引用前判断。 */
export function isUploadSuccessKind(kind: UploadResultKind): kind is {
  kind: "success";
  skipped: boolean;
} {
  return kind.kind === "success";
}

export type { UploadFile };
