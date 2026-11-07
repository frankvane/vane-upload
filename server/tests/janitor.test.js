const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { sweepOrphanChunks } = require("../src/janitor");

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
