/**
 * 分片键协议的「服务端一侧」唯一实现。
 *
 * 前端 `src/shared/chunkKey.ts` 有等价的 TS 实现；
 * `src/shared/chunkKey.contract.test.ts` 会逐组输入比对两者，
 * 任一侧改动而另一侧未同步时契约测试立即失败。
 *
 * 协议形如 `${md5}_${size}_${chunkSize}`：
 * - md5 标识内容；size 防同内容不同大小冲突；chunkSize 让网络自适应后
 *   新旧分片天然隔离；
 * - 字符全部落在服务端 sanitizeFileId 白名单 `[a-zA-Z0-9_-]` 内；
 * - 缺 size/chunkSize 时退化为纯 md5（兼容旧键）。
 */
const buildChunkKey = (md5, size, chunkSize) => {
  const safeMd5 = typeof md5 === "string" ? md5.trim() : "";
  const safeSize = Number.isFinite(size) ? Number(size) : 0;
  const safeChunkSize = Number.isFinite(chunkSize) ? Number(chunkSize) : 0;

  if (!safeMd5) {
    return "";
  }
  if (!safeSize || !safeChunkSize) {
    return safeMd5;
  }
  return `${safeMd5}_${safeSize}_${safeChunkSize}`;
};

module.exports = { buildChunkKey };
