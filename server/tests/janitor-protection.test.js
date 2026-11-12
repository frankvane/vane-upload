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

/** 轮询等待可观测状态；超时即失败，避免「什么都没发生也算通过」。 */
const waitFor = async (predicate, timeoutMs, label) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`等待超时：${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

test("VU-15/T-73：janitor 每次扫描都重新求值保护集合，集合变化后清理结论随之改变", async () => {
  // T-73 修正：旧用例的 `current` 恒为空、只扫一次、唯一断言是「未保护 → 被删」，
  // 与标题无关；即使生产改成「启动时取一次快照后复用」也照样全绿（假绿）。
  // 现在让保护集合在两次扫描之间真实变化，并断言分片状态随之翻转。
  const freePath = writeStaleChunk("dyn_free_0");
  const guardedPath = writeStaleChunk("dyn_guarded_0");
  let current = new Set(["dyn_guarded"]);
  const snapshots = [];
  const stop = startOrphanChunkJanitor({
    dir: TMP_DIR,
    ttlHours: 0.0001, // 360ms，48h 前的分片一律过期
    intervalHours: 0.00001, // 36ms，便于在测试内触发多次扫描
    protectFileIds: () => {
      snapshots.push(new Set(current));
      return current;
    },
    logger: { info() {}, error() {} },
  });

  try {
    await waitFor(
      () => !fs.existsSync(freePath),
      2000,
      "未保护分片应在首次扫描被清理"
    );
    assert.equal(
      fs.existsSync(guardedPath),
      true,
      "受保护分片在首次扫描必须保留"
    );
    assert.deepEqual(
      snapshots[0],
      new Set(["dyn_guarded"]),
      "首次扫描读到的是初始保护集合"
    );

    // 模拟合并结束：该 storageId 不再受保护。若生产只在启动时取一次快照，
    // 这里读到的仍是旧集合，guarded 分片会永远留着 → 下面的等待超时转红。
    current = new Set();
    await waitFor(
      () => !fs.existsSync(guardedPath),
      2000,
      "保护撤销后分片应在后续扫描被清理"
    );
    assert.equal(fs.existsSync(freePath), false);
    assert.equal(fs.existsSync(guardedPath), false);
    assert.equal(
      snapshots.findIndex((snapshot) => snapshot.size === 0) > 0,
      true,
      "必须存在一次「非首次」扫描读到了更新后的空保护集合"
    );
    assert.deepEqual(
      snapshots.at(-1),
      new Set(),
      "最后一次扫描读到的是更新后的集合"
    );
  } finally {
    stop();
  }
});

test("T-60：合并 staging（.part）属于受保护 storageId 时不被 TTL 清理", async () => {
  // staging 命名 `${storedFileName}.${storageId}.part`，storageId 不含点，
  // 由 `.part` 前最后一段还原。受保护的 storageId 即使在长合并 + 极短 TTL 下也不被截断。
  writeStaleChunk("stored_name.abc.protected_file.part");
  const protectedIds = new Set(["protected_file"]);
  const removed = await sweepOrphanChunks({
    dir: TMP_DIR,
    ttlMs: 1000,
    getProtectedFileIds: () => protectedIds,
  });
  assert.ok(
    !removed.includes("stored_name.abc.protected_file.part"),
    "受保护的 .part staging 必须保留",
  );
});

test("T-60：孤儿合并 staging（.part）且不在受保护集合时照常清理", async () => {
  writeStaleChunk("stored_name.abc.orphan_file.part");
  const removed = await sweepOrphanChunks({
    dir: TMP_DIR,
    ttlMs: 1000,
    getProtectedFileIds: () => new Set(["other"]),
  });
  assert.ok(
    removed.includes("stored_name.abc.orphan_file.part"),
    "孤儿 .part staging 应被清理",
  );
});
