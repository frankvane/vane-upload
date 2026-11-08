// VU-54 拆分配套：mergeIo.moveIntoPlace 的 IO 语义单测。
// 覆盖：同卷 rename、跨卷 EXDEV 退化为 copy+unlink、非 EXDEV 错误原样冒泡。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { moveIntoPlace } = require("../src/controllers/mergeIo");

test("同目录 rename 成功移动文件并清除源", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mergeio-"));
  const src = path.join(dir, "src.bin");
  const dst = path.join(dir, "dst.bin");
  fs.writeFileSync(src, "hello");
  await moveIntoPlace(src, dst);
  assert.equal(fs.existsSync(dst), true);
  assert.equal(fs.existsSync(src), false);
  assert.equal(fs.readFileSync(dst, "utf8"), "hello");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("EXDEV 退化为 copy + unlink（跨卷兼容）", async () => {
  const originalRename = fs.promises.rename;
  const originalCopy = fs.promises.copyFile;
  const originalUnlink = fs.promises.unlink;
  const calls = { rename: 0, copy: 0, unlink: 0 };

  fs.promises.rename = async () => {
    calls.rename += 1;
    const err = new Error("cross-device");
    err.code = "EXDEV";
    throw err;
  };
  fs.promises.copyFile = async () => {
    calls.copy += 1;
  };
  fs.promises.unlink = async () => {
    calls.unlink += 1;
  };

  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mergeio-"));
    const src = path.join(dir, "src.bin");
    const dst = path.join(dir, "dst.bin");
    fs.writeFileSync(src, "data");
    await moveIntoPlace(src, dst);
    assert.equal(calls.rename, 1);
    assert.equal(calls.copy, 1);
    assert.equal(calls.unlink, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    fs.promises.rename = originalRename;
    fs.promises.copyFile = originalCopy;
    fs.promises.unlink = originalUnlink;
  }
});

test("非 EXDEV 错误原样冒泡，不退化", async () => {
  const originalRename = fs.promises.rename;
  fs.promises.rename = async () => {
    const err = new Error("EACCES");
    err.code = "EACCES";
    throw err;
  };
  try {
    await assert.rejects(() => moveIntoPlace("/x", "/y"), /EACCES/);
  } finally {
    fs.promises.rename = originalRename;
  }
});
