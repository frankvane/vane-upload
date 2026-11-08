// VU-54：从 uploadController 抽离的「HTTP 响应格式化 + 请求身份解析 + 文件存在性判断」辅助。
// 这些辅助与 HTTP 层最紧密，但本身是纯函数，可被独立测试。

const fs = require("fs");
const { buildScopedFileId } = require("../utils/fileSecurity");

// VU-52：请求路径里的存在性判断改用异步 access，避免同步 IO 阻塞事件循环
// （原 fs.existsSync 在高频 /status、合并校验、回滚清理时都会触发）。
// 语义与 existsSync 一致：任何已存在的条目（文件/目录）都返回 true。
const fileExists = (filePath) =>
  fs.promises
    .access(filePath, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);

// P2-9：身份只认鉴权中间件写入的 req.user，绝不读取请求体 user_id。
// 未经过鉴权的调用（仅 demo / 单测直调控制器）回退到历史默认用户 "test"。
const getUserId = (req) =>
  req && req.user && req.user.id ? String(req.user.id) : "test";

// VU-01/VU-02：客户端 file_id 是内容派生的公共键，绝不能直接作为存储键。
// 分片文件、落盘文件名、FileChunk.file_id 一律使用叠加用户命名空间的 storageId。
const getStorageId = (req, safeFileId) =>
  buildScopedFileId(getUserId(req), safeFileId);

const jsonError = (res, statusCode, message, data = {}) =>
  res.status(statusCode).json({ code: statusCode, message, data });

const jsonOk = (res, data = {}) => res.json({ code: 200, message: "ok", data });

const httpError = (statusCode, message, details = undefined) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
};

/**
 * P2-9：秒传 / 已合并只回传调用方真正需要的字段。
 * 此前直接序列化 Sequelize 实例，把 file_path、user_id、thumbnail_path 等
 * 内部信息一并透出；且查询不带 user 维度，形成跨租户信息泄漏面。
 */
const toPublicFile = (file) => {
  if (!file) {
    return null;
  }
  const plain = typeof file.toJSON === "function" ? file.toJSON() : { ...file };
  // 落库值是 `<userId>:<chunkKey>`（保证 file_id 全局唯一），对外仍回传客户端使用的 chunkKey。
  const rawFileId = String(plain.file_id || "");
  const separator = rawFileId.indexOf(":");
  return {
    file_id: separator >= 0 ? rawFileId.slice(separator + 1) : rawFileId,
    file_name: plain.file_name,
    size: plain.size,
    md5: plain.md5,
    file_ext: plain.file_ext,
    file_type: plain.file_type,
    category_id: plain.category_id,
    created_at: plain.created_at,
  };
};

module.exports = {
  fileExists,
  getUserId,
  getStorageId,
  jsonError,
  jsonOk,
  httpError,
  toPublicFile,
};
