/**
 * T-75（聚类④）后端低优先级四项回归。
 * --------------------------------------------------------------------------
 * 1) chunkStateQueue：flush 失败恢复不得覆盖 persist 期间新入队的状态；
 *    /api/health 的 lastError 必须脱敏（路径 / token / 存储键）。
 * 2) fileSecurity：文件名 NFKC 归一化、双向/隐形控制符过滤、按 code point
 *    截断不留孤立 surrogate。
 * 3) config：DEMO_USER_ID 含冒号时启动自检拒绝；文件 id / mergeKey 的
 *    「取末段」解析对含冒号 userId 仍正确。
 * 4) development 下 5xx 脱敏见 error-handler.test.js / hardening.test.js。
 *
 * 隔离：进程级临时目录 + NODE_ENV=test，flush 定时器拉长到 60s，
 * 所有刷盘都由用例显式触发，不触碰仓库内真实 data/tmp/uploads。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rui-t75-"));
process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "demo";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.DB_STORAGE = path.join(testRoot, "db.sqlite");
process.env.SERVER_TMP_UPLOAD_DIR = path.join(testRoot, "tmp");
process.env.SERVER_UPLOADS_DIR = path.join(testRoot, "uploads");
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";
delete process.env.CORS_ORIGIN;

const { config, validateStartupConfig } = require("../src/config");
const { sanitizeFilename } = require("../src/utils/fileSecurity");
const { toPublicFile } = require("../src/controllers/response");
const { FileChunk } = require("../src/models");
const queue = require("../src/services/chunkStateQueue");
const {
  getMergingStorageIds,
  __mergeLockInternals,
} = require("../src/controllers/uploadController");

test.after(() => {
  try {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } catch {
    // Windows 上若 SQLite 句柄尚未释放，交由 OS 临时目录回收，不影响断言。
  }
});

/** 逐 code unit 检查是否存在落单的 high / low surrogate。 */
const hasLoneSurrogate = (value) => {
  const s = String(value);
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
};

// ---------------------------------------------------------------------------
// 1) flush 失败恢复：新入队状态优先
// ---------------------------------------------------------------------------
test("T-75 flush 失败恢复不覆盖期间新入队状态（状态不倒退）", async () => {
  await queue.resetChunkStateQueueForTests();
  const original = FileChunk.bulkCreate;
  // 故意不含 "SQLITE_BUSY"，避免 withSqliteBusyRetry 的重试延迟污染用例。
  FileChunk.bulkCreate = async () => {
    // batch 已被 drainPendingStates 摘出，此处模拟 persist 期间同 key 的新状态入队。
    queue.enqueueChunkState({
      file_id: "t75-file",
      chunk_index: 0,
      status: 2,
      size: 999,
    });
    throw new Error("simulated persist failure");
  };
  try {
    queue.enqueueChunkState({
      file_id: "t75-file",
      chunk_index: 0,
      status: 1,
      size: 10,
    });
    await assert.rejects(
      () => queue.flushPendingChunkStates(),
      /simulated persist failure/
    );
    const pending = queue.getPendingChunkStates("t75-file");
    assert.equal(pending.length, 1, "同 key 不应出现两份待刷状态");
    assert.equal(pending[0].status, 2, "新入队状态必须保留");
    assert.equal(pending[0].size, 999, "失败的旧批次不得覆盖新值");
  } finally {
    FileChunk.bulkCreate = original;
    await queue.resetChunkStateQueueForTests();
  }
});

test("T-75 /api/health 的 lastError 不泄漏路径 / token / 存储键", async () => {
  await queue.resetChunkStateQueueForTests();
  const original = FileChunk.bulkCreate;
  FileChunk.bulkCreate = async () => {
    throw new Error(
      "SQLITE_CANTOPEN /home/alice/secret.db?token=abc123 file_id: u1:secretkey"
    );
  };
  try {
    queue.enqueueChunkState({ file_id: "t75-health", chunk_index: 0 });
    await assert.rejects(() => queue.flushPendingChunkStates());
    const lastError = String(queue.getQueueHealth().lastError || "");
    assert.ok(lastError.length > 0, "失败必须可观测（不能假绿）");
    assert.ok(!lastError.includes("/home/alice"), "绝对路径未脱敏");
    assert.ok(!lastError.includes("abc123"), "token 未脱敏");
    assert.ok(!lastError.includes("secretkey"), "存储键未脱敏");
  } finally {
    FileChunk.bulkCreate = original;
    await queue.resetChunkStateQueueForTests();
  }
});

// ---------------------------------------------------------------------------
// 2) 文件名 Unicode 归一化 / 混淆字符 / 安全截断
// ---------------------------------------------------------------------------
test("T-75 文件名 NFKC 归一化 + 双向控制符过滤 + 组合字符规范", () => {
  assert.ok(
    !sanitizeFilename("evil\u202Etxt.exe").includes("\u202E"),
    "U+202E RTL override 必须被过滤"
  );
  assert.ok(
    !sanitizeFilename("report\u2066.pdf").includes("\u2066"),
    "U+2066 LRI 必须被过滤"
  );
  assert.ok(
    !sanitizeFilename("zero\u200Bwidth.txt").includes("\u200B"),
    "零宽空格必须被过滤"
  );

  const fullwidth = sanitizeFilename("ａ／ｂ\uFF0F.txt");
  assert.ok(!fullwidth.includes("/"), "NFKC 折叠出的斜杠必须被过滤");
  assert.ok(!fullwidth.includes("\uFF0F"), "不得残留全角斜杠");
  assert.ok(fullwidth.includes("a"), "全角字母应归一化为 ASCII");

  // NFKC 含 canonical composition：e + U+0301 -> é
  assert.equal(sanitizeFilename("cafe\u0301.txt"), "caf\u00E9.txt");
});

test("T-75 超长 emoji 名按 code point 截断，不产生孤立 surrogate", () => {
  const long = sanitizeFilename("\u{1F600}".repeat(200));
  assert.ok(long.length > 0, "截断后不能为空");
  assert.ok(long.length <= 255, `长度应受列宽约束，实际 ${long.length}`);
  assert.equal(hasLoneSurrogate(long), false, "末尾不得留下半个 emoji");
  // 边界恰落在 surrogate pair 之前：254 个 ASCII + 1 个 emoji 应被整体丢弃。
  const boundary = sanitizeFilename("a".repeat(254) + "\u{1F600}");
  assert.equal(boundary.length, 254);
  assert.equal(hasLoneSurrogate(boundary), false);
});

// ---------------------------------------------------------------------------
// 3) 冒号 userId：启动自检 + 两处末段解析
// ---------------------------------------------------------------------------
test("T-75 DEMO_USER_ID 含冒号时启动自检拒绝", () => {
  const saved = {
    demo: process.env.DEMO_USER_ID,
    auth: process.env.AUTH_MODE,
    token: process.env.FILE_AUTH_TOKEN,
  };
  try {
    process.env.AUTH_MODE = "demo";
    delete process.env.FILE_AUTH_TOKEN;
    delete process.env.DEMO_USER_ID;
    assert.equal(
      validateStartupConfig({ checkWritable: false }).ok,
      true,
      "合法配置基线应通过"
    );
    assert.equal(config.demoUserId(), "test");

    process.env.DEMO_USER_ID = "org:alice";
    const check = validateStartupConfig({ checkWritable: false });
    assert.equal(check.ok, false, "含冒号 userId 必须被拒绝");
    assert.ok(check.errors.some((line) => line.includes("DEMO_USER_ID")));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      const envKey = {
        demo: "DEMO_USER_ID",
        auth: "AUTH_MODE",
        token: "FILE_AUTH_TOKEN",
      }[key];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});

test("T-75 toPublicFile 对含冒号 userId 仍回传末段 chunkKey", () => {
  const pub = toPublicFile({
    file_id: "org:alice:chunk-key",
    file_name: "a.txt",
  });
  assert.equal(pub.file_id, "chunk-key");
});

test("T-75 getMergingStorageIds 对含冒号 userId 取末段 storageId", async () => {
  const locks = __mergeLockInternals.mergeLocks;
  const { release } = await locks.acquireOrWait("org:alice:t75-storage");
  try {
    assert.deepEqual(Array.from(getMergingStorageIds()), ["t75-storage"]);
  } finally {
    release();
  }
});
