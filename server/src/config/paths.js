const fs = require("fs");
const path = require("path");

const SERVER_ROOT = path.resolve(__dirname, "..", "..");
// 允许通过环境变量覆盖数据/缓存/上传/下载目录，便于 e2e / 容器将状态隔离到临时卷。
// 不设时使用仓库内默认目录（行为不变）。
const DATA_DIR = process.env.SERVER_DATA_DIR
  ? path.resolve(process.env.SERVER_DATA_DIR)
  : path.join(SERVER_ROOT, "data");
const TMP_UPLOAD_DIR = process.env.SERVER_TMP_UPLOAD_DIR
  ? path.resolve(process.env.SERVER_TMP_UPLOAD_DIR)
  : path.join(SERVER_ROOT, "tmp", "upload");
const UPLOADS_DIR = process.env.SERVER_UPLOADS_DIR
  ? path.resolve(process.env.SERVER_UPLOADS_DIR)
  : path.join(SERVER_ROOT, "uploads");

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
};

const ensureBaseDirs = () => {
  [DATA_DIR, TMP_UPLOAD_DIR, UPLOADS_DIR].forEach(ensureDir);
};

module.exports = {
  SERVER_ROOT,
  DATA_DIR,
  TMP_UPLOAD_DIR,
  UPLOADS_DIR,
  ensureDir,
  ensureBaseDirs,
};
