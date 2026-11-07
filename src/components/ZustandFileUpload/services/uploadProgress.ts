import type { UploadProgressDetail } from "../types/upload";

export interface ComputeUploadProgressInput {
  /** 已上传字节数 */
  uploadedBytes: number;
  /** 文件总字节数（需 > 0 才有意义） */
  totalBytes: number;
  /** 上传阶段已耗时（毫秒，>= 0） */
  elapsedMs: number;
}

const SAFE_MIN_SPEED = 1; // 避免 0 除导致 Infinity/NaN

/**
 * 由字节累加推导上传进度详情（T3.4）。
 *
 * - progress：已上传占比 [0-100]，满 100 表示完成；
 * - speed：瞬时速率（字节/秒），由 uploadedBytes / elapsed 推导；
 * - eta：预计剩余时间（秒），(总-已传)/speed，无法估算（speed≈0 或已传=总量）时为 0。
 *
 * 所有分支均做极值保护：elapsed=0 时 speed 记 0（尚未产生速率），
 * 避免 Infinity/NaN 污染 UI；uploadedBytes>=totalBytes 时进度钳到 100、eta 归零。
 */
export function computeUploadProgress(
  input: ComputeUploadProgressInput
): UploadProgressDetail {
  const { uploadedBytes, totalBytes, elapsedMs } = input;

  const safeTotal = totalBytes > 0 ? totalBytes : 0;
  const safeUploaded = Math.max(0, Math.min(uploadedBytes, safeTotal));

  let progress = 0;
  if (safeTotal > 0) {
    progress = Math.round((safeUploaded / safeTotal) * 100);
    if (progress >= 100) {
      progress = 100;
    }
  }

  let speed = 0;
  if (elapsedMs > 0 && safeUploaded > 0) {
    speed = Math.round((safeUploaded / elapsedMs) * 1000); // 字节/秒
  }

  let eta = 0;
  const remainingBytes = safeTotal - safeUploaded;
  if (remainingBytes > 0 && speed >= SAFE_MIN_SPEED) {
    eta = Math.round(remainingBytes / speed);
  }

  return {
    progress,
    uploadedBytes: safeUploaded,
    totalBytes: safeTotal,
    speed,
    eta,
  };
}
