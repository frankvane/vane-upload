const multer = require("multer");

// 分片大小上限（MB）：环境变量 CHUNK_MAX_SIZE_MB 可覆盖，默认 20。
// 客户端 chunkSize 自适应范围 256KB~8MB，20MB 留有充分余量。
const maxChunkSizeMb = (() => {
  const parsed = Number.parseFloat(process.env.CHUNK_MAX_SIZE_MB || "");
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 20;
})();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxChunkSizeMb * 1024 * 1024,
  },
});

const uploadChunk = upload.single("chunk");

module.exports = {
  uploadChunk,
  maxChunkSizeMb,
};
