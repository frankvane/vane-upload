/**
 * T-73：真实 kill -9 崩溃恢复。
 *
 * 看板原文指出 TC-24「崩溃重启」只是同进程重新查一次 /status，不是真实崩溃。
 * 本用例用两个**独立子进程**共享同一 SQLite 库与上传目录：第一个进程上传 2/4
 * 片后被父进程 SIGKILL 强杀（不是正常退出、不 close DB），第二个全新进程只读
 * 崩溃前的持久化状态并续传、合并，精确断言分片与产物字节完整。
 *
 * 目录 / DB 全部落在 os.tmpdir() 的私有临时根，after 整体删除，仓库零新增文件。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const CHILD = path.join(__dirname, "helpers", "t73-crash-child.js");
const SERVER_ROOT = path.resolve(__dirname, "..");

const runChild = (env, phase, killOnReady) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD], {
      cwd: SERVER_ROOT,
      env: { ...process.env, ...env, T73_PHASE: phase },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (killOnReady && !killed && stdout.includes("SEED_READY")) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      resolve({ code, signal, stdout, stderr, killed }),
    );
  });

test("T-73：真实 SIGKILL 崩溃后跨进程续传，分片与产物字节完整", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rui-t73-crash-"));
  const env = {
    T73_DB_STORAGE: path.join(root, "crash.sqlite"),
    T73_TMP_UPLOAD_DIR: path.join(root, "tmp"),
    T73_UPLOADS_DIR: path.join(root, "uploads"),
  };

  try {
    const seed = await runChild(env, "seed", true);
    assert.equal(seed.killed, true, "必须在种子进程上报就绪后发起强杀");
    assert.equal(
      seed.signal,
      "SIGKILL",
      "种子进程必须是被 SIGKILL 杀死，而非正常退出"
    );
    assert.equal(seed.code, null, "强杀进程不得有正常退出码");
    const seedLine = seed.stdout
      .split("\n")
      .find((candidate) => candidate.startsWith("SEED_READY "));
    assert.ok(seedLine, `种子进程必须打印 SEED_READY，实际=${seed.stdout}`);
    assert.deepEqual(
      JSON.parse(seedLine.slice("SEED_READY ".length)).statuses,
      [200, 200],
      "崩溃前两片必须都已确认成功"
    );
    assert.equal(seed.stderr, "", "种子进程不应有任何报错");

    const recover = await runChild(env, "recover", false);
    assert.equal(
      recover.code,
      0,
      `恢复子进程应正常退出：stderr=${recover.stderr}`
    );
    assert.equal(recover.stderr, "", "恢复子进程不应有任何报错");
    const line = recover.stdout
      .split("\n")
      .find((candidate) => candidate.startsWith("RESULT "));
    assert.ok(line, `恢复进程必须打印 RESULT，实际 stdout=${recover.stdout}`);
    const result = JSON.parse(line.slice("RESULT ".length));

    // 崩溃前已确认的 2 片必须在全新进程里仍然可见（DB + 磁盘都持久化了）。
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.resumed, [0, 1]);
    assert.deepEqual(result.uploadStatuses, [200, 200], "续传两片都应成功");
    assert.equal(result.mergeStatus, 200);
    assert.equal(result.mergeCode, 200);
    assert.equal(result.rowCount, 1, "产物必须恰好落盘 1 行");
    assert.equal(
      result.artifactMd5,
      result.expectedMd5,
      "合并产物字节必须与四片原文完全一致（崩溃未丢片、未串片）"
    );
    assert.equal(result.artifactBytes, "alphabravocharliedelta".length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
