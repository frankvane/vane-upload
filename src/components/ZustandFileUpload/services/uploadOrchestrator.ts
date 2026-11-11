import { UploadFile, type UploadStorage } from "../types/upload";
import { listUploadFiles } from "./uploadStorage";

interface QueueTaskResult<T> {
  item: T;
  index: number;
  success: boolean;
  /** T-14：排队期被判为「不需要执行」（如记录已被用户删除）而跳过 */
  skipped?: boolean;
  /** T-33：任务或前置钩子抛出的异常，透传给 onSettled 而不是静默吞掉 */
  error?: unknown;
}

/**
 * T-14：`beforeEach` 可以否决本件任务。
 *
 * 返回 `"skip"` 表示「这件不用跑了」——典型场景是排队期间用户删掉了这条记录：
 * 不跑任务、也不计失败。此前只能用 `return` 表达「什么都没做」，队列仍以
 * `task()` 的 `false` 把它计入 failedCount，于是「删掉 2 个再取消」会凭空多 2 个失败。
 */
export type BeforeEachOutcome = "skip" | void;

interface RunConcurrentQueueOptions<T> {
  items: T[];
  concurrency: number;
  beforeEach?: (item: T, index: number) => Promise<BeforeEachOutcome>;
  task: (item: T, index: number) => Promise<boolean>;
  onSettled?: (result: QueueTaskResult<T>) => Promise<void> | void;
  shouldStop?: () => boolean;
}

export interface QueueSummary {
  successCount: number;
  failedCount: number;
  /** T-14：排队期间被跳过（未执行、也不计失败）的任务数 */
  skippedCount: number;
}

export const loadAllUploadFiles = async (
  storage: UploadStorage
): Promise<UploadFile[]> => {
  return listUploadFiles(storage);
};

/** T-36：非法并发数（NaN / Infinity / 0 / 负数）回落到 1，并钳到任务数。 */
export const normalizeConcurrency = (value: number, itemCount: number): number => {
  const total = Math.max(1, Math.floor(Number.isFinite(itemCount) ? itemCount : 1));
  const requested = Number.isFinite(value) ? Math.floor(value) : 1;
  return Math.max(1, Math.min(requested < 1 ? 1 : requested, total));
};

export const runConcurrentQueue = async <T>(
  options: RunConcurrentQueueOptions<T>
): Promise<QueueSummary> => {
  const { items, beforeEach, task, onSettled, shouldStop } = options;
  const concurrency = normalizeConcurrency(options.concurrency, items.length);

  if (items.length === 0) {
    return { successCount: 0, failedCount: 0, skippedCount: 0 };
  }

  let cursor = 0;
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  /**
   * T-33：onSettled 由宿主提供，抛异常不能把整批 Promise.all 拖成 reject
   * （否则批次收尾不执行、isUploading 永久 true，还留下未处理拒绝）。
   * 异常本身已通过 result.error 透传给宿主自行处理。
   */
  const settle = async (result: QueueTaskResult<T>): Promise<void> => {
    try {
      await onSettled?.(result);
    } catch {
      // 宿主回调失败不影响其它任务的结算
    }
  };

  const runner = async () => {
    while (true) {
      if (shouldStop?.()) {
        return;
      }

      const currentIndex = cursor;
      cursor += 1;

      if (currentIndex >= items.length) {
        return;
      }

      const item = items[currentIndex];
      if (item === undefined) {
        return;
      }

      // T-33：beforeEach 抛异常时该件计失败、把 error 透传给 onSettled，
      // 其余任务继续执行，而不是让整批 reject。
      let outcome: BeforeEachOutcome;
      try {
        outcome = await beforeEach?.(item, currentIndex);
      } catch (error) {
        failedCount += 1;
        await settle({ item, index: currentIndex, success: false, error });
        continue;
      }

      // T-14：被 beforeEach 否决的任务不执行、不计成功也不计失败，只记「已跳过」。
      // 仍然回调 onSettled，让上层把批次计数（current / active）推进到位。
      if (outcome === "skip") {
        skippedCount += 1;
        await settle({ item, index: currentIndex, success: false, skipped: true });
        continue;
      }

      let success = false;
      let taskError: unknown;
      try {
        success = await task(item, currentIndex);
      } catch (error) {
        taskError = error;
      }

      if (success) {
        successCount += 1;
      } else {
        failedCount += 1;
      }

      await settle({ item, index: currentIndex, success, error: taskError });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runner()));

  return {
    successCount,
    failedCount,
    skippedCount,
  };
};
