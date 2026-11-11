const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { TMP_UPLOAD_DIR } = require("../config/paths");

// DB 中 file_id / file_name 的列宽；客户端输入必须在此截断，
// 否则超长值会让 writeFile 抛 ENAMETOOLONG 或让 SQL 写入静默截断。
const MAX_FILE_ID_LENGTH = 90;
const MAX_FILENAME_LENGTH = 255;

const sanitizeFilename = (inputName) => {
  const baseName = path.basename(String(inputName || ""));
  // 控制字符（\u0000-\u001f）需显式剔除，避免文件名注入/截断；该字符类是刻意的。
  // eslint-disable-next-line no-control-regex
  const sanitized = baseName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return (sanitized || `file-${Date.now()}`).slice(0, MAX_FILENAME_LENGTH);
};

const sanitizeFileId = (fileId) =>
  String(fileId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, MAX_FILE_ID_LENGTH);

/**
 * VU-01/VU-02：把「用户」维度编码进所有存储键。
 * 客户端 file_id 是按内容派生的 chunkKey，同内容不同用户必然相同——
 * 分片路径、落盘文件名、FileChunk.file_id 都必须叠加用户命名空间，
 * 否则 B 可以覆盖 A 的分片，或让一次失败的合并删掉 A 的文件。
 * 用定长 hex 摘要而不是原始 userId：不含路径分隔符、长度可控、不可逆推凭据。
 */
const getUserScope = (userId) =>
  `u${crypto
    .createHash("sha256")
    .update(String(userId ?? "test"))
    .digest("hex")
    .slice(0, 12)}`;

const buildScopedFileId = (userId, fileId) =>
  `${getUserScope(userId)}_${sanitizeFileId(fileId)}`;

const MD5_PATTERN = /^[a-f0-9]{32}$/i;

/** 仅接受标准 32 位十六进制 md5，杜绝路径分隔符 / 空字节混入落盘文件名（P0-2）。 */
const isValidMd5 = (value) =>
  typeof value === "string" && MD5_PATTERN.test(value);

const pathError = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

/**
 * 把文件名安全地拼到基准目录下；解析后越出基准目录即抛 400（P0-2）。
 * 调用方不得再把未经本函数处理的用户输入送进 fs 写入/删除路径。
 *
 * VU-34：词法 path.resolve 挡不住「父目录本身是符号链接」。此处补一层
 * realpath 校验：若 target 的父目录解析到基准目录之外，同样拒绝。
 * 目录尚未创建时 realpath 会抛 ENOENT，此时由 ensureDir 创建、词法判断已足够。
 */
const resolveInsideBase = (baseDir, fileName) => {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, String(fileName || ""));
  if (!target.startsWith(base + path.sep)) {
    throw pathError("invalid file path");
  }
  try {
    const realBase = fs.realpathSync(base);
    const realParent = fs.realpathSync(path.dirname(target));
    if (realParent !== realBase && !realParent.startsWith(realBase + path.sep)) {
      throw pathError("invalid file path (symlinked parent)");
    }
  } catch (error) {
    if (error.statusCode === 400) throw error;
    // 目录不存在：跳过 realpath 校验
  }
  return target;
};

/**
 * VU-34：写入 / 读取前的符号链接防护。
 * 用 lstat（不跟随链接）判断目标；已存在但不是普通文件（symlink / 目录 /
 * FIFO / device）一律 403，绝不跟随写入。返回 null 表示目标尚不存在。
 */
const inspectWriteTarget = async (filePath) => {
  let stat = null;
  try {
    stat = await fs.promises.lstat(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    const error = new Error("unsafe file target: not a regular file");
    error.statusCode = 403;
    throw error;
  }
  return stat;
};

/**
 * VU-34：O_NOFOLLOW 写入，堵住「lstat 检查完、writeFile 之前被换成 symlink」
 * 的 TOCTOU 窗口。Windows 没有 O_NOFOLLOW（常量为 0），退化为打开后 fstat 校验，
 * 依旧不会跟随到一个目录或非普通文件。
 */
const writeRegularFile = async (filePath, buffer) => {
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_TRUNC |
    (fs.constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await fs.promises.open(filePath, flags, 0o600);
  } catch (error) {
    if (error.code === "ELOOP" || error.code === "EMLINK") {
      const forbidden = new Error("unsafe file target: symbolic link");
      forbidden.statusCode = 403;
      throw forbidden;
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      const forbidden = new Error("unsafe file target: not a regular file");
      forbidden.statusCode = 403;
      throw forbidden;
    }
    await handle.writeFile(buffer);
  } finally {
    await handle.close();
  }
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
  inspectWriteTarget,
  writeRegularFile,
  getUserScope,
  buildScopedFileId,
  MAX_FILE_ID_LENGTH,
  MAX_FILENAME_LENGTH,
};
