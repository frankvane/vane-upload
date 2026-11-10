import { UploadFile, type UploadStorage } from "../types/upload";
import { listUploadFiles } from "./uploadStorage";

interface QueueTaskResult<T> {
  item: T;
  index: number;
  success: boolean;
  /** T-14：排队期被判为「不需要执行」（如记录已被用户删除）而跳过 */
  skipped?: boolean;
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

export const runConcurrentQueue = async <T>(
  options: RunConcurrentQueueOptions<T>
): Promise<QueueSummary> => {
  const { items, beforeEach, task, onSettled, shouldStop } = options;
  const concurrency = Math.max(1, Math.min(options.concurrency, items.length || 1));

  if (items.length === 0) {
    return { successCount: 0, failedCount: 0, skippedCount: 0 };
  }

  let cursor = 0;
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

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

      const outcome = await beforeEach?.(item, currentIndex);

      // T-14：被 beforeEach 否决的任务不执行、不计成功也不计失败，只记「已跳过」。
      // 仍然回调 onSettled，让上层把批次计数（current / active）推进到位。
      if (outcome === "skip") {
        skippedCount += 1;
        await onSettled?.({ item, index: currentIndex, success: false, skipped: true });
        continue;
      }

      let success = false;
      try {
        success = await task(item, currentIndex);
      } catch {
        success = false;
      }

      if (success) {
        successCount += 1;
      } else {
        failedCount += 1;
      }

      await onSettled?.({ item, index: currentIndex, success });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runner()));

  return {
    successCount,
    failedCount,
    skippedCount,
  };
};
