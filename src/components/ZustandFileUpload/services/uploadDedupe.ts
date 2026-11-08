/** 可用于内容指纹比对的字段子集（store 记录与预处理结果都满足）。 */
export interface ContentKeyed {
  hash?: string | null;
  fileSize?: number;
  lastModified?: number;
  fileName: string;
}

/**
 * VU-19：内容指纹 = hash|size|lastModified|fileName。
 * 同一物理文件重复选择会得到相同的指纹，据此去重，避免生成多条队列记录；
 * 同时保留 P1-7 的语义——仅「同内容不同名」仍可并存（fileName 不同即不同指纹）。
 */
export const buildContentKey = (file: ContentKeyed): string =>
  `${file.hash ?? ""}|${file.fileSize ?? 0}|${file.lastModified ?? 0}|${file.fileName}`;

export interface DedupeResult<T extends ContentKeyed> {
  /** 真正需要入队的新项 */
  newItems: T[];
  /** 因重复被跳过的条数 */
  skipped: number;
}

/**
 * 从待入队集合中剔除与「已在队列中的记录」或「本批内已出现」内容指纹相同的项。
 * 纯函数，便于单元测试锁定 VU-19 行为。
 */
export const dedupeByContentKey = <T extends ContentKeyed & { id: string }>(
  existing: ContentKeyed[],
  incoming: T[]
): DedupeResult<T> => {
  const existingKeys = new Set(existing.map(buildContentKey));
  const seenInBatch = new Set<string>();
  const newItems: T[] = [];
  let skipped = 0;

  for (const item of incoming) {
    const key = buildContentKey(item);
    if (existingKeys.has(key) || seenInBatch.has(key)) {
      skipped += 1;
      continue;
    }
    seenInBatch.add(key);
    newItems.push(item);
  }

  return { newItems, skipped };
};
