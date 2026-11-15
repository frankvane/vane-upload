const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { sweepOrphanChunks, sweepOrphanUploads } = require("../src/janitor");

const TTL_MS = 24 * 60 * 60 * 1000;

const makeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "janitor-test-"));

const setOld = (filePath, ageMs) => {
  const past = (Date.now() - ageMs) / 1000;
  fs.utimesSync(filePath, past, past);
};

test("过期分片被删除，新分片保留", async () => {
  const dir = makeDir();
  try {
    const old = path.join(dir, "abc_1024_1048576_0");
    const fresh = path.join(dir, "abc_1024_1048576_1");
    fs.writeFileSync(old, "orphan");
    fs.writeFileSync(fresh, "active");
    setOld(old, TTL_MS + 60 * 1000);

    const removed = await sweepOrphanChunks({ dir, ttlMs: TTL_MS });

    assert.deepEqual(removed, ["abc_1024_1048576_0"]);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(".gitkeep 占位文件永不被清理", async () => {
  const dir = makeDir();
  try {
    const keep = path.join(dir, ".gitkeep");
    fs.writeFileSync(keep, "");
    setOld(keep, TTL_MS * 10); // 远超 TTL

    const removed = await sweepOrphanChunks({ dir, ttlMs: TTL_MS });

    assert.deepEqual(removed, []);
    assert.equal(fs.existsSync(keep), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("边界：age 略小于 TTL 不删，超过才删", async () => {
  const dir = makeDir();
  try {
    const edge = path.join(dir, "edge");
    const expired = path.join(dir, "expired");
    fs.writeFileSync(edge, "x");
    fs.writeFileSync(expired, "x");
    // 留 1 分钟余量：mtime 设置与 sweep 的 now 之间存在执行延迟
    setOld(edge, TTL_MS - 60 * 1000);
    setOld(expired, TTL_MS + 60 * 1000);

    const removed = await sweepOrphanChunks({ dir, ttlMs: TTL_MS });
    assert.deepEqual(removed, ["expired"]);
    assert.equal(fs.existsSync(edge), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("目录不存在时安全返回空列表", async () => {
  const removed = await sweepOrphanChunks({
    dir: path.join(os.tmpdir(), "janitor-not-exist-xyz"),
    ttlMs: TTL_MS,
  });
  assert.deepEqual(removed, []);
});

test("子目录不被当作文件删除", async () => {
  const dir = makeDir();
  try {
    fs.mkdirSync(path.join(dir, "subdir"));
    fs.writeFileSync(path.join(dir, "subdir", "inside"), "x");

    const removed = await sweepOrphanChunks({ dir, ttlMs: TTL_MS });
    assert.deepEqual(removed, []);
    assert.equal(fs.existsSync(path.join(dir, "subdir", "inside")), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepOrphanUploads：已知（已落库）文件保留，孤儿超 TTL 删除", async () => {
  const dir = makeDir();
  try {
    const known = path.join(
      dir,
      "u0123456789ab_f_abcdef0123456789abcdef0123456789.png",
    );
    const orphan = path.join(
      dir,
      "u0123456789ab_f_deadbeefdeadbeefdeadbeefdeadbeef.png",
    );
    fs.writeFileSync(known, "k");
    fs.writeFileSync(orphan, "o");
    setOld(orphan, TTL_MS + 60 * 1000);

    const removed = await sweepOrphanUploads({
      dir,
      ttlMs: TTL_MS,
      getKnownFileNames: () => new Set([path.basename(known)]),
    });

    assert.deepEqual(removed, [path.basename(orphan)]);
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.existsSync(known), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepOrphanUploads：正在合并的 storageId 受保护，跳过其落盘文件", async () => {
  const dir = makeDir();
  try {
    // 即便超 TTL，只要 storageId 仍「正在合并」就不能删（moveIntoPlace 已落盘但事务未提交）。
    const merging = path.join(
      dir,
      "uMERGING_f_abcdef0123456789abcdef0123456789.png",
    );
    fs.writeFileSync(merging, "m");
    setOld(merging, TTL_MS + 60 * 1000);

    const removed = await sweepOrphanUploads({
      dir,
      ttlMs: TTL_MS,
      getKnownFileNames: () => new Set(),
      getProtectedFileIds: () => new Set(["uMERGING_f"]),
    });

    assert.deepEqual(removed, []);
    assert.equal(fs.existsSync(merging), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepOrphanUploads：非 vane 命名文件不擅自删除", async () => {
  const dir = makeDir();
  try {
    const other = path.join(dir, "random-file.txt");
    fs.writeFileSync(other, "x");
    setOld(other, TTL_MS + 60 * 1000);

    const removed = await sweepOrphanUploads({
      dir,
      ttlMs: TTL_MS,
      getKnownFileNames: () => new Set(),
    });

    assert.deepEqual(removed, []);
    assert.equal(fs.existsSync(other), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
