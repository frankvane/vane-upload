/**
 * 受控并发工具（零依赖，主线程与 Worker 共用）。
 *
 * VU-43：把彼此独立的异步 IO 从「串行 await」改为受控并发池，
 *        结果按原 index 归并，不改变调用方观察到的顺序。
 * VU-49：分片上传用游标按需取下一个 index，避免为数千个分片
 *        预先 `map` 出同等数量的任务闭包（内存 O(N) → O(1)）。
 */

export interface CursorPoolOptions {
  /** 返回下一个待执行任务的索引；返回 undefined 表示队列已耗尽。 */
  next: () => number | undefined;
  concurrency: number;
  /** T-76：本轮待执行任务总数；提供后 runner 数不会超过任务数（对齐 mapWithConcurrency）。 */
  totalTasks?: number;
  task: (index: number) => Promise<void>;
  /** 每轮领取新任务前检查是否应当停止（取消 / 暂停）。 */
  shouldStop?: () => boolean;
  onSuccess?: (index: number) => void;
  onFailure?: (index: number, error: unknown) => void;
}

export interface CursorPoolSummary {
  completed: number;
  failed: number;
  failedIndices: number[];
}

/**
 * T-76：并发硬上限。concurrency 由用户配置经 Worker 注入，
 * 旧实现 Array.from({length: 巨大值}) 会一次性拉起海量 runner，
 * 内存与在途连接同时被打爆；统一钳到 MAX_CONCURRENCY。
 */
export const MAX_CONCURRENCY = 32;

export const normalizeConcurrency = (value: number): number => {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(value)));
};

/**
 * 游标式并发池：只保留一个共享 cursor，runner 数量固定为 concurrency。
 * 单个任务失败不会中断其余任务（与原 `runWithConcurrency` 语义一致）。
 */
export const runCursorPool = async (
  options: CursorPoolOptions
): Promise<CursorPoolSummary> => {
  const { next, concurrency, task, shouldStop, onSuccess, onFailure } = options;
  const normalized = normalizeConcurrency(concurrency);
  // T-76：与 mapWithConcurrency 对齐——runner 数既受硬上限约束，也不超过任务数。
  const total = Number.isFinite(options.totalTasks)
    ? Math.max(1, Math.floor(options.totalTasks as number))
    : normalized;
  const runners = Math.min(normalized, total);
  const failedIndices: number[] = [];
  let completed = 0;
  let failed = 0;

  const runner = async (): Promise<void> => {
    while (true) {
      if (shouldStop?.()) return;
      const index = next();
      if (index === undefined) return;

      try {
        await task(index);
        completed += 1;
        onSuccess?.(index);
      } catch (error) {
        failed += 1;
        failedIndices.push(index);
        onFailure?.(index, error);
      }
    }
  };

  await Promise.all(Array.from({ length: runners }, () => runner()));

  return { completed, failed, failedIndices };
};

/**
 * 并发 map：结果写入与输入等长的数组，按原 index 归位。
 * `task` 内部自行处理单条失败（返回 undefined 表示该条被跳过），
 * 未捕获的异常会让整个池 reject，便于调用方按批次处理。
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R | undefined>,
): Promise<Array<R | undefined>> => {
  const results = new Array<R | undefined>(items.length);
  const workers = Math.min(
    normalizeConcurrency(concurrency),
    Math.max(1, items.length),
  );
  let cursor = 0;

  const runner = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: workers }, () => runner()));
  return results;
};
