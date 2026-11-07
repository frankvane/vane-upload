import { UploadFile } from "../types/upload";
import { listUploadFiles } from "./uploadStorage";

interface QueueTaskResult<T> {
  item: T;
  index: number;
  success: boolean;
}

interface RunConcurrentQueueOptions<T> {
  items: T[];
  concurrency: number;
  beforeEach?: (item: T, index: number) => Promise<void>;
  task: (item: T, index: number) => Promise<boolean>;
  onSettled?: (result: QueueTaskResult<T>) => Promise<void> | void;
  shouldStop?: () => boolean;
}

interface QueueSummary {
  successCount: number;
  failedCount: number;
}

export const loadAllUploadFiles = async (
  storage: LocalForage
): Promise<UploadFile[]> => {
  return listUploadFiles(storage);
};

export const runConcurrentQueue = async <T>(
  options: RunConcurrentQueueOptions<T>
): Promise<QueueSummary> => {
  const { items, beforeEach, task, onSettled, shouldStop } = options;
  const concurrency = Math.max(1, Math.min(options.concurrency, items.length || 1));

  if (items.length === 0) {
    return { successCount: 0, failedCount: 0 };
  }

  let cursor = 0;
  let successCount = 0;
  let failedCount = 0;

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

      await beforeEach?.(item, currentIndex);

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
  };
};
