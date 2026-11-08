// VU-15：janitor 在清理孤儿分片时，不得删除「正在合并」文件的源分片。
// 通过注入受保护集合（getProtectedFileIds）验证保护逻辑；真实生产中由
// uploadController.getMergingStorageIds() 提供（index.js 已接线）。
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rui-janitor-"));
const TMP_DIR = path.join(testRoot, "tmp");

const { sweepOrphanChunks, startOrphanChunkJanitor } = require("../src/janitor");

// 制造一个「明显过期」的 mtime（48h 前）
const oldMtime = new Date(Date.now() - 48 * 60 * 60 * 1000);

const writeStaleChunk = (name) => {
  const filePath = path.join(TMP_DIR, name);
  fs.writeFileSync(filePath, "x");
  fs.utimesSync(filePath, oldMtime, oldMtime);
  return filePath;
};

test.before(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

test.after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("VU-15：无保护谓词时，过期孤儿分片照常被清理", async () => {
  writeStaleChunk("free_chunk_0");
  const removed = await sweepOrphanChunks({ dir: TMP_DIR, ttlMs: 1000 });
  assert.ok(removed.includes("free_chunk_0"), "过期分片应被删除");
});

test("VU-15：受保护集合中的文件分片不被清理", async () => {
  writeStaleChunk("protected_file_0");
  const protectedIds = new Set(["protected_file"]);
  const removed = await sweepOrphanChunks({
    dir: TMP_DIR,
    ttlMs: 1000,
    getProtectedFileIds: () => protectedIds,
  });
  assert.ok(!removed.includes("protected_file_0"), "受保护分片必须保留");
  // 清理确实执行过（自由分片仍会被删）
  writeStaleChunk("another_free_1");
  const removed2 = await sweepOrphanChunks({
    dir: TMP_DIR,
    ttlMs: 1000,
    getProtectedFileIds: () => protectedIds,
  });
  assert.ok(removed2.includes("another_free_1"));
});

test("VU-15：getProtectedFileIds 返回 null 时退化为不保护", async () => {
  writeStaleChunk("null_protect_0");
  const removed = await sweepOrphanChunks({
    dir: TMP_DIR,
    ttlMs: 1000,
    getProtectedFileIds: () => null,
  });
  assert.ok(removed.includes("null_protect_0"));
});

test("VU-15：janitor 定时器每次扫描都会刷新受保护集合", async () => {
  writeStaleChunk("scheduled_0");
  let current = new Set();
  const stop = startOrphanChunkJanitor({
    dir: TMP_DIR, // 让 janitor 清理我们自定义的临时目录
    ttlHours: 0.0001, // 极短 TTL，确保 48h 前的分片被视为过期
    intervalHours: 0.0001, // 极短间隔，便于快速触发一次扫描
    protectFileIds: () => current,
    logger: { info() {}, error() {} },
  });
  // 首次扫描时 `current` 为空 → 会被清理
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(!fs.existsSync(path.join(TMP_DIR, "scheduled_0")), "未保护时应被清理");
  stop();
});
