/**
 * 上传队列 id 生成器。
 *
 * 旧版直接使用 md5 作为队列 id，同内容文件（不同名/不同次选择）会互相覆盖
 * （IndexedDB 同主键 upsert），第二个文件顶掉第一个（P1-7）。
 * 新版在 md5 之外拼接 size、lastModified 与随机后缀，保证唯一。
 */

const randomSuffix = (): string => {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 8);
};

export const buildQueueId = (
  md5: string | undefined | null,
  size: number | undefined | null,
  lastModified?: number | null
): string => {
  const safeMd5 = typeof md5 === "string" ? md5.trim() : "";
  const safeSize = Number.isFinite(size) ? Number(size) : 0;
  const safeLastModified = Number.isFinite(lastModified)
    ? Number(lastModified)
    : 0;
  return `${safeMd5}_${safeSize}_${safeLastModified}_${randomSuffix()}`;
};
