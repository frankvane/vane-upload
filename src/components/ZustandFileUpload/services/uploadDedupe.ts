import { UploadStatus, type UploadHashMode } from "../types/upload";

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
  const { newItems, rebindItems, skipped } = reconcileIncomingFiles(
    existing as RebindableRecord[],
    incoming
  );
  return { newItems, skipped: skipped + rebindItems.length };
};

/** 可被「重新选择文件」接管的既有记录（中断 / 失败 / 排队，且内存中已无 fileRef）。 */
export interface RebindableRecord extends ContentKeyed {
  id: string;
  status?: UploadStatus | string;
  chunkSize?: number;
  chunkCount?: number;
  fileRef?: File;
  hashMode?: UploadHashMode;
  createdAt?: number;
  order?: number;
}

export interface RebindPair<T> {
  existing: RebindableRecord;
  incoming: T;
}

export interface ReconcileResult<T> {
  /** 需要新建的记录 */
  newItems: T[];
  /** 内容命中既有中断记录：复用既有 id / chunkSize，重新绑定文件引用 */
  rebindItems: RebindPair<T>[];
  /** 已在队列中且不可复用（已完成 / 正在上传）的条数 */
  skipped: number;
}

const REBINDABLE_STATUSES = new Set<UploadStatus>([
  UploadStatus.ERROR,
  UploadStatus.PAUSED,
  UploadStatus.QUEUED,
  UploadStatus.QUEUED_FOR_UPLOAD,
]);

/**
 * E2E-02：区分「真正的新文件」与「刷新后重新选择的同一文件」。
 * 前者新建记录（chunkSize 按当前网络自适应）；后者复用既有记录与 chunkSize，
 * 保证服务端分片键 `${md5}_${size}_${chunkSize}` 跨会话稳定，从而只补传缺失分片。
 */
export const reconcileIncomingFiles = <
  T extends ContentKeyed & { id: string }
>(
  existing: RebindableRecord[],
  incoming: T[]
): ReconcileResult<T> => {
  const byKey = new Map<string, RebindableRecord>();
  for (const record of existing) {
    const key = buildContentKey(record);
    if (!byKey.has(key)) {
      byKey.set(key, record);
    }
  }

  const seenInBatch = new Set<string>();
  const newItems: T[] = [];
  const rebindItems: RebindPair<T>[] = [];
  let skipped = 0;

  for (const item of incoming) {
    const key = buildContentKey(item);
    if (seenInBatch.has(key)) {
      skipped += 1;
      continue;
    }
    seenInBatch.add(key);

    const record = byKey.get(key);
    if (!record) {
      newItems.push(item);
      continue;
    }

    const canRebind =
      !record.fileRef &&
      record.status !== undefined &&
      REBINDABLE_STATUSES.has(record.status as UploadStatus);

    if (canRebind) {
      rebindItems.push({ existing: record, incoming: item });
    } else {
      skipped += 1;
    }
  }

  return { newItems, rebindItems, skipped };
};
