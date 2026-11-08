const fs = require("fs");
const os = require("os");
const path = require("path");
const { getEnv } = require("./index");

const SERVER_ROOT = path.resolve(__dirname, "..", "..");

/**
 * VU-61：测试进程绝不能碰仓库内的 `server/data` / `tmp` / `uploads`。
 * 旧实现里只要某个测试文件忘了设 DB_STORAGE，require(app) 就会打开默认的
 * `server/data/indexeddb-upload.sqlite`；还有测试在 after 里对默认目录做
 * 「全目录 unlink」，会误删非本测试产生的文件。
 *
 * 这里在 NODE_ENV=test 且未显式覆盖目录时，统一重定向到进程私有的临时目录，
 * 并在进程退出时清理。显式设置了 SERVER_*_DIR 的用例仍走自己的目录。
 * 生产 / 开发行为完全不变。
 */
const isTestProcess = () => getEnv("NODE_ENV", "") === "test";
const TEST_ROOT = isTestProcess()
  ? fs.mkdtempSync(path.join(os.tmpdir(), "rui-server-test-"))
  : null;

const DEFAULT_DATA_DIR = path.join(SERVER_ROOT, "data");
const DEFAULT_TMP_UPLOAD_DIR = path.join(SERVER_ROOT, "tmp", "upload");
const DEFAULT_UPLOADS_DIR = path.join(SERVER_ROOT, "uploads");

const resolveDir = (envKey, fallback) => {
  const raw = getEnv(envKey, "");
  if (raw) return path.resolve(raw);
  if (TEST_ROOT) return path.join(TEST_ROOT, path.basename(fallback));
  return fallback;
};

const DATA_DIR = resolveDir("SERVER_DATA_DIR", DEFAULT_DATA_DIR);
const TMP_UPLOAD_DIR = resolveDir("SERVER_TMP_UPLOAD_DIR", DEFAULT_TMP_UPLOAD_DIR);
const UPLOADS_DIR = resolveDir("SERVER_UPLOADS_DIR", DEFAULT_UPLOADS_DIR);

if (TEST_ROOT) {
  // 目录必须预先存在：部分用例 rely on uploads/ 已存在（moveIntoPlace 不建父目录）。
  for (const dir of [DATA_DIR, TMP_UPLOAD_DIR, UPLOADS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  process.on("exit", () => {
    try {
      fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    } catch {
      // 退出阶段清理失败不影响测试结果
    }
  });
}

// VU-52：ensureDir 每请求 2~3 次 existsSync 是纯浪费。目录一旦建好就缓存，
// 只在启动自检 / 显式调用 ensureBaseDirs() 时重新确认。
const ensuredDirs = new Set();

const ensureDir = (dirPath, { force = false } = {}) => {
  if (!force && ensuredDirs.has(dirPath)) {
    return dirPath;
  }
  // VU-52：mkdirSync(recursive) 对已存在目录是幂等的，无需先 existsSync 探活
  // （旧实现每请求 2~3 次同步 stat 阻塞事件循环）。ensuredDirs 缓存避免重复系统调用。
  fs.mkdirSync(dirPath, { recursive: true });
  ensuredDirs.add(dirPath);
  return dirPath;
};

const ensureBaseDirs = () => {
  [DATA_DIR, TMP_UPLOAD_DIR, UPLOADS_DIR].forEach((dir) =>
    ensureDir(dir, { force: true })
  );
};

module.exports = {
  SERVER_ROOT,
  TEST_ROOT,
  DATA_DIR,
  TMP_UPLOAD_DIR,
  UPLOADS_DIR,
  ensureDir,
  ensureBaseDirs,
};
