const multer = require("multer");
const { config } = require("../config");

// 分片大小上限（MB）：环境变量 CHUNK_MAX_SIZE_MB 可覆盖，默认 20。
// 客户端 chunkSize 自适应范围 256KB~8MB，20MB 留有充分余量。
// VU-55：读取与合法性校验统一走 config。
const maxChunkSizeMb = config.chunkMaxSizeMb();

// VU-32：只限 fileSize 时，multipart 的字段数 / 部件数 / 字段长度仍是 Infinity，
// 单请求可携带海量小字段打满事件循环与堆。全部收紧到上传分片实际需要的范围。
// busboy 用 `fileSize === fileSizeLimit` 触发 limit 事件，fileSize 是整数字节数；
// 若 CHUNK_MAX_SIZE_MB 为小数（如 0.001），乘积是 1048.576，条件永不成立，
// 分片大小上限会静默失效。必须向下取整为整数。
const maxChunkSizeBytes = Math.max(
  1,
  Math.floor(maxChunkSizeMb * 1024 * 1024)
);

// VU-59：修复 off-by-one。multer 在 fileSize === limit 时即触发 LIMIT_FILE_SIZE，
// 导致「恰好等于声明上限」的分片被 413 拒绝（如 1MiB 上限时 1MiB 文件被拒）。
// 把 limit 设为 maxChunkSizeBytes + 1，使「恰好 maxChunkSizeBytes」可放行、
// 只有「超出 1 字节」才 413，且实际可放行上限仍为 maxChunkSizeBytes，不会放宽。
const maxChunkSizeLimit = maxChunkSizeBytes + 1;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxChunkSizeLimit,
    fieldSize: 16 * 1024,
    fields: 16,
    parts: 20,
    files: 1,
  },
});

const uploadChunk = upload.single("chunk");

module.exports = {
  uploadChunk,
  maxChunkSizeMb,
  maxChunkSizeBytes,
};
