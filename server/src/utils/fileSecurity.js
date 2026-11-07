const path = require("path");
const { TMP_UPLOAD_DIR } = require("../config/paths");

const sanitizeFilename = (inputName) => {
  const baseName = path.basename(String(inputName || ""));
  const sanitized = baseName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return sanitized || `file-${Date.now()}`;
};

const sanitizeFileId = (fileId) =>
  String(fileId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "");

const MD5_PATTERN = /^[a-f0-9]{32}$/i;

/** 仅接受标准 32 位十六进制 md5，杜绝路径分隔符 / 空字节混入落盘文件名（P0-2）。 */
const isValidMd5 = (value) =>
  typeof value === "string" && MD5_PATTERN.test(value);

/**
 * 把文件名安全地拼到基准目录下；解析后越出基准目录即抛 400（P0-2）。
 * 调用方不得再把未经本函数处理的用户输入送进 fs 写入/删除路径。
 */
const resolveInsideBase = (baseDir, fileName) => {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, String(fileName || ""));
  if (!target.startsWith(base + path.sep)) {
    const error = new Error("invalid file path");
    error.statusCode = 400;
    throw error;
  }
  return target;
};

/**
 * 解析新版复合分片键：`${md5}_${size}_${chunkSize}`（客户端 buildChunkKey 生成）。
 * 旧版纯 md5 键或自定义键返回 null（走兼容逻辑，不做一致性校验）。
 */
const parseChunkKey = (fileId) => {
  const match = /^([a-f0-9]{32})_(\d+)_(\d+)$/.exec(String(fileId || ""));
  if (!match) {
    return null;
  }
  return {
    md5: match[1],
    size: Number(match[2]),
    chunkSize: Number(match[3]),
  };
};

const buildChunkPath = (fileId, index) => path.join(TMP_UPLOAD_DIR, `${fileId}_${index}`);

module.exports = {
  sanitizeFilename,
  sanitizeFileId,
  isValidMd5,
  resolveInsideBase,
  parseChunkKey,
  buildChunkPath,
};
