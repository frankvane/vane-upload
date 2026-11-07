/**
 * 分片存储键（服务端 file_id）生成器。
 *
 * 形如 `${md5}_${size}_${chunkSize}`：
 * - md5 标识内容；size 防同内容不同大小冲突；chunkSize 使网络自适应
 *   （256KB~8MB 动态调整）后新旧分片天然隔离，不会互相污染（P1-6）；
 * - 字符全部落在服务端 sanitizeFileId 白名单 `[a-zA-Z0-9_-]` 内；
 * - 旧版纯 md5 键的请求服务端按兼容逻辑处理（parseChunkKey 返回 null）。
 */
export const buildChunkKey = (
  md5: string | undefined | null,
  size: number | undefined | null,
  chunkSize: number | undefined | null
): string => {
  const safeMd5 = typeof md5 === "string" ? md5.trim() : "";
  const safeSize = Number.isFinite(size) ? Number(size) : 0;
  const safeChunkSize = Number.isFinite(chunkSize) ? Number(chunkSize) : 0;

  if (!safeMd5) {
    return "";
  }
  if (!safeSize || !safeChunkSize) {
    // 缺 size/chunkSize 时退化为纯 md5（兼容旧行为）
    return safeMd5;
  }
  return `${safeMd5}_${safeSize}_${safeChunkSize}`;
};
