import { UploadStatus, type UploadHashMode } from "../types/upload";

/** 可用于内容指纹比对的字段子集（store 记录与预处理结果都满足）。 */
export interface ContentKeyed {
  hash?: string | null;
  fileSize?: number;
  lastModified?: number;
  fileName: string;
}

/**
 * VU-19：内容指纹 = hash\u0000size\u0000lastModified\u0000fileName。
 * 用 \u0000（NUL）作分隔符而非 `|`：hash 是十六进制串、size/lastModified 是数字、
 * fileName 不含 NUL，因此任一字段含 `|`（如自定义 MIME / 别名 `a|b`）也不会让两个
 * 不同元组拼成同一字符串，消除指纹碰撞（T-59）。同一物理文件重复选择得到相同指纹
 * → 去重；仅「同内容不同名」仍可并存（fileName 不同即不同指纹，保留 P1-7 语义）。
 */
export const buildContentKey = (file: ContentKeyed): string =>
  [file.hash ?? "", file.fileSize ?? 0, file.lastModified ?? 0, file.fileName]
    .map((value) => String(value))
    .join("\u0000");

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
 *
 * 内容指纹仅在「双方都有 hash」时参与匹配：无 hash（如 hashMode 未计算）无法可靠
 * 标识内容，不纳入内容去重，避免两个无 hash 且 size/name/lastModified 相同的不同文件
 * 被误判重复（T-59「hash 空时不做内容去重」）。
 */
export const reconcileIncomingFiles = <
  T extends ContentKeyed & { id: string }
>(
  existing: RebindableRecord[],
  incoming: T[]
): ReconcileResult<T> => {
  const byKey = new Map<string, RebindableRecord>();
  for (const record of existing) {
    // 无 hash 无法可靠标识内容，不纳入内容去重（见上方说明）。
    if (!record.hash) continue;
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
