// 批次 8 回归：VU-09（请求体解析顺序 / chunk_md5s）、VU-33（文件类型策略）、
// VU-34（符号链接防护）、VU-38（日志分级脱敏）、VU-55（集中配置）、
// VU-56 / VU-14（死代码与未声明依赖）、VU-08（合并锁）、VU-53（复合索引）。
//
// T-23 skip 归档：本文件 3 处 t.skip 都是**环境能力缺失**，不是断言失败，
// 也不代表对应防护被移除：
//  1) 创建符号链接被系统拒绝（2 处）→ Linux / macOS 原生可跑；Windows 需
//     开启「开发者模式」或以管理员身份运行，CI 用 ubuntu-latest 即可覆盖。
//  2) fs.lutimesSync 不存在（1 处）→ Node ≥ 20.10 / ≥ 18.20 已提供，
//     升级 Node 后本用例自动恢复执行（当前 CI 为 Node 22）。
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rui-hardening3-"));
process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "demo";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.DB_STORAGE = path.join(testRoot, "db.sqlite");
process.env.SERVER_TMP_UPLOAD_DIR = path.join(testRoot, "tmp");
process.env.SERVER_UPLOADS_DIR = path.join(testRoot, "uploads");
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";

const app = require("../src/app");
const { syncModels, sequelize } = require("../src/models");
const { ensureBaseDirs, TMP_UPLOAD_DIR, UPLOADS_DIR } = require("../src/config/paths");
const { config, validateStartupConfig } = require("../src/config");
const { md5Buffer } = require("../src/utils/hash");
const { buildScopedFileId } = require("../src/utils/fileSecurity");
const { sweepOrphanChunks } = require("../src/janitor");
const { createMergeLockRegistry } = require("../src/utils/mergeLock");
const {
  logger,
  redactLogText,
  getSafePath,
  setLoggerSink,
} = require("../src/utils/logger");

const scoped = (fileId) => buildScopedFileId("test", fileId);

const uploadChunk = (fileId, index, buffer) =>
  request(app)
    .post("/api/file/upload")
    .field("file_id", fileId)
    .field("index", String(index))
    .attach("chunk", buffer, { filename: `${fileId}.bin` });

const mergeOne = ({ fileId, name, buffer, hashMode }) => {
  const md5 = md5Buffer(buffer);
  return request(app)
    .post("/api/file/merge")
    .send({
      file_id: fileId,
      name,
      size: buffer.length,
      md5,
      total: 1,
      ...(hashMode ? { hash_mode: hashMode } : {}),
    });
};

test.before(async () => {
  ensureBaseDirs();
  await syncModels({ force: true });
});

test.after(async () => {
  await sequelize.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- VU-33
test("VU-33：危险扩展名 evil.html / evil.svg / evil.exe 合并返回 415，uploads 零残留", async () => {
  const content = Buffer.from("<html><script>alert(1)</script></html>");
  for (const name of ["evil.html", "evil.svg", "evil.exe"]) {
    const fileId = `f-type-${name.split(".")[1]}`;
    assert.equal((await uploadChunk(fileId, 0, content)).status, 200);
    const res = await mergeOne({ fileId, name, buffer: content });
    assert.equal(res.status, 415, `${name} 应被拒绝`);
    assert.match(res.body.message, /不允许上传|不在允许的白名单/);
  }

  const leaked = fs
    .readdirSync(UPLOADS_DIR)
    .filter((name) => name.startsWith("f-type-"));
  assert.deepEqual(leaked, [], "415 时不得有文件落在 uploads");
  const staging = fs
    .readdirSync(TMP_UPLOAD_DIR)
    .filter((name) => name.includes(".part"));
  assert.deepEqual(staging, [], "415 时 staging 必须清理");
});

// ---------------------------------------------------------------- T-39
test("T-39：双扩展名 payload.html.png 承载 HTML 内容，合并返回 415，uploads 零残留", async () => {
  const content = Buffer.from(
    "<html><body><script>alert(1)</script></body></html>"
  );
  const fileId = "t39-double-ext";
  assert.equal((await uploadChunk(fileId, 0, content)).status, 200);
  const res = await mergeOne({
    fileId,
    name: "payload.html.png",
    buffer: content,
  });
  assert.equal(res.status, 415, "双扩展名不得绕过危险类型校验");
  assert.match(res.body.message, /不允许上传/);
  const leaked = fs
    .readdirSync(UPLOADS_DIR)
    .filter((name) => name.startsWith(scoped(fileId)));
  assert.deepEqual(leaked, [], "415 时不得以 .png 落盘");
});

test("T-39：文件名无害但内容为 HTML 标记，未配白名单时也要 415", async () => {
  const content = Buffer.from("<script>window.location='//evil'</script>");
  const fileId = "t39-markup";
  assert.equal((await uploadChunk(fileId, 0, content)).status, 200);
  const res = await mergeOne({ fileId, name: "payload.png", buffer: content });
  assert.equal(res.status, 415, "mime=null 的 HTML 载体不得放行");
  assert.equal(res.body.data.reason, "dangerous-markup");
});

test("VU-33：配置 ALLOWED_MIME_TYPES 后，探测不出类型的文件也被拒绝；合法 .bin 仍可合并", async () => {
  const content = Buffer.from("plain text that file-type cannot classify");
  const okId = "f-type-allowed-default";
  assert.equal((await uploadChunk(okId, 0, content)).status, 200);
  assert.equal(
    (await mergeOne({ fileId: okId, name: "safe.bin", buffer: content })).status,
    200
  );

  process.env.ALLOWED_MIME_TYPES = "image/png";
  try {
    // 必须与上一条内容不同，否则会命中「同一 md5+size 已合并」而提前返回 200。
    const strictContent = Buffer.from("another unclassifiable payload for whitelist");
    const strictId = "f-type-whitelist";
    assert.equal((await uploadChunk(strictId, 0, strictContent)).status, 200);
    const res = await mergeOne({
      fileId: strictId,
      name: "unknown.bin",
      buffer: strictContent,
    });
    assert.equal(res.status, 415);
    assert.equal(res.body.data.reason, "mime-not-allowlisted");
  } finally {
    delete process.env.ALLOWED_MIME_TYPES;
  }
});

// ---------------------------------------------------------------- VU-34
test("VU-34：预置符号链接分片 → 403，目录外目标文件字节不变", async (t) => {
  const outside = path.join(testRoot, "outside-secret.txt");
  fs.writeFileSync(outside, "ORIGINAL-BYTES");
  const fileId = "f-symlink-chunk";
  const linkPath = path.join(TMP_UPLOAD_DIR, `${scoped(fileId)}_0`);
  try {
    fs.symlinkSync(outside, linkPath, "file");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      // T-23：见文件头 skip 归档第 1 条；开发者模式/管理员或 POSIX 下可跑。
      t.skip("当前系统不允许创建符号链接（Windows 需开发者模式/管理员）");
      return;
    }
    throw error;
  }

  const res = await uploadChunk(fileId, 0, Buffer.from("MALICIOUS"));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 403);
  assert.equal(fs.readFileSync(outside, "utf8"), "ORIGINAL-BYTES");
  fs.unlinkSync(linkPath);
});

test("VU-34：janitor 用 lstat 清理过期符号链接，且不触碰链接目标", async (t) => {
  const dir = fs.mkdtempSync(path.join(testRoot, "janitor-"));
  const outside = path.join(testRoot, "janitor-target.txt");
  fs.writeFileSync(outside, "KEEP-ME");
  const link = path.join(dir, "orphan_0");
  try {
    fs.symlinkSync(outside, link, "file");
    const oldSeconds = (Date.now() - 48 * 60 * 60 * 1000) / 1000;
    if (typeof fs.lutimesSync === "function") {
      fs.lutimesSync(link, oldSeconds, oldSeconds);
    } else {
      // T-23：见文件头 skip 归档第 2 条；Node ≥20.10 / ≥18.20 可跑。
      t.skip("当前 Node 不支持 lutimesSync，无法只改链接自身 mtime");
      return;
    }
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      // T-23：见文件头 skip 归档第 1 条；开发者模式/管理员或 POSIX 下可跑。
      t.skip("当前系统不允许创建符号链接");
      return;
    }
    throw error;
  }

  const removed = await sweepOrphanChunks({ dir, ttlMs: 1000, now: Date.now() });
  assert.ok(removed.includes("orphan_0"), "过期软链必须被清理");
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.readFileSync(outside, "utf8"), "KEEP-ME");
});

// ---------------------------------------------------------------- VU-09
test("VU-09：chunk_md5s 元素非字符串 / 超长 / 含空白 → 400，不再进入后续 IO", async () => {
  const base = {
    file_id: "f-md5s-validation",
    md5: "a".repeat(32),
    name: "x.bin",
    size: 3,
  };
  for (const bad of [
    { evil: true },
    [{ nested: 1 }],
    "x".repeat(65),
    "has space",
  ]) {
    const res = await request(app)
      .post("/api/file/instant")
      .send({ ...base, chunk_md5s: [bad] });
    assert.equal(res.status, 400, `chunk_md5s=${JSON.stringify(bad)} 应被拒绝`);
  }
  const notArray = await request(app)
    .post("/api/file/instant")
    .send({ ...base, chunk_md5s: "not-an-array" });
  assert.equal(notArray.status, 400);
});

// ---------------------------------------------------------------- VU-38
test("VU-38：日志脱敏 token / query 键名 / 绝对路径，且只记路径模板", () => {
  const lines = [];
  setLoggerSink((_level, line) => lines.push(line));
  try {
    logger.info(
      "GET /api/file/status?file_id=SECRET_ID&md5=SECRET_MD5 " +
        "Authorization: Bearer SUPER_SECRET_TOKEN C:\\Users\\admin\\secret.txt"
    );
    logger.error(new Error("failed at /home/runner/app/src/secret.js"));
  } finally {
    setLoggerSink(null);
  }
  const output = lines.join("\n");
  assert.ok(output.includes("[INFO]") && output.includes("[ERROR]"), "分级标记");
  assert.ok(!output.includes("SUPER_SECRET_TOKEN"));
  assert.ok(!output.includes("SECRET_ID"));
  assert.ok(!output.includes("SECRET_MD5"));
  assert.ok(!output.includes("file_id="), "query 键名也不应出现");
  assert.ok(!output.includes("secret.txt"), "绝对路径应被替换");
  assert.ok(output.includes("[redacted]"));
  assert.ok(output.includes("[path]"));

  assert.equal(
    getSafePath({ originalUrl: "/api/file/status?file_id=abc&md5=def" }),
    "/api/file/status"
  );
  assert.match(
    redactLogText("token=BAREA_SECRET_123"),
    /\*\*\*|\[redacted\]/
  );
});

// ---------------------------------------------------------------- VU-55
test("VU-55：RATE_LIMIT_MAX=0 有明确语义，凭据保持大小写，启动自检能识别缺凭据", () => {
  const saved = {
    rate: process.env.RATE_LIMIT_MAX,
    token: process.env.FILE_AUTH_TOKEN,
    auth: process.env.AUTH_MODE,
  };
  try {
    process.env.RATE_LIMIT_MAX = "0";
    assert.equal(config.rateLimitMax(), 0, "0 不再被 || 300 静默改回");
    process.env.RATE_LIMIT_MAX = "500";
    assert.equal(config.rateLimitMax(), 500);

    process.env.FILE_AUTH_TOKEN = "AbC-MixedCase-Token";
    assert.deepEqual(config.bearerTokens(), ["AbC-MixedCase-Token"]);

    delete process.env.FILE_AUTH_TOKEN;
    delete process.env.FILE_AUTH_COOKIE;
    process.env.AUTH_MODE = "secure";
    const check = validateStartupConfig({ checkWritable: false });
    assert.equal(check.ok, false);
    assert.ok(check.errors.some((line) => line.includes("AUTH_MODE=secure")));

    process.env.FILE_AUTH_TOKEN = "good-token";
    assert.equal(validateStartupConfig({ checkWritable: false }).ok, true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      const envKey = {
        rate: "RATE_LIMIT_MAX",
        token: "FILE_AUTH_TOKEN",
        auth: "AUTH_MODE",
      }[key];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});

test("VU-55：所有 process.env 读取收敛到 src/config/index.js", () => {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : full.endsWith(".js") ? [full] : [];
    });
  const offenders = walk(path.join(__dirname, "../src")).filter((file) => {
    if (file.endsWith(path.join("config", "index.js"))) return false;
    return /process\.env/.test(fs.readFileSync(file, "utf8"));
  });
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------- VU-08
test("VU-08：合并锁等待有超时，且等待者数量有上限", async () => {
  const timed = createMergeLockRegistry({
    waitTimeoutMs: () => 20,
    maxWaiters: () => 5,
  });
  const releaseTimed = timed.acquire("k");
  await assert.rejects(
    () => timed.wait("k"),
    (error) => error.statusCode === 503 && /timeout/.test(error.message)
  );
  releaseTimed();
  assert.equal(timed.size(), 0);

  const capped = createMergeLockRegistry({
    waitTimeoutMs: () => 5000,
    maxWaiters: () => 1,
  });
  const releaseCapped = capped.acquire("k");
  const firstWaiter = capped.wait("k");
  await assert.rejects(
    () => capped.wait("k"),
    (error) => error.statusCode === 429
  );
  releaseCapped();
  await firstWaiter;
  assert.equal(capped.waiters("k"), 0);
});

// ---------------------------------------------------------------- VU-53 / VU-56 / VU-14
test("VU-53：files / file_chunks 建出复合索引", async () => {
  for (const table of ["files", "file_chunks"]) {
    const [rows] = await sequelize.query(`PRAGMA index_list('${table}')`);
    const names = rows.map((row) => row.name).join(",");
    assert.match(names, /user_id/, `${table} 应有 user_id 复合索引`);
  }
});

test("VU-56 / VU-14：死代码与未声明依赖已移除", () => {
  const hashUtils = require("../src/utils/hash");
  assert.deepEqual(Object.keys(hashUtils).sort(), ["md5Buffer", "md5File"]);
  assert.equal(
    fs.existsSync(path.join(__dirname, "../src/utils/thumbnail.js")),
    false
  );
  const pkg = require("../package.json");
  assert.equal("mime-types" in pkg.dependencies, false);
  assert.equal("sharp" in pkg.dependencies, false);
});

// ---------------------------------------------------------------- VU-61 / VU-57
test("VU-61：测试进程的数据目录在仓库之外，默认 sqlite 不会被打开", () => {
  const { DATA_DIR, TMP_UPLOAD_DIR, UPLOADS_DIR, TEST_ROOT, SERVER_ROOT } =
    require("../src/config/paths");
  assert.ok(TEST_ROOT, "test 进程必须创建私有临时根目录");
  // 本文件显式覆盖了 TMP/UPLOADS 目录，只有 DATA_DIR 走自动重定向；
  // 三者共同的不变式是「都不在仓库内」，且目录已预建。
  assert.ok(DATA_DIR.startsWith(TEST_ROOT), "未显式覆盖的目录必须自动重定向");
  for (const dir of [DATA_DIR, TMP_UPLOAD_DIR, UPLOADS_DIR]) {
    assert.equal(dir.startsWith(SERVER_ROOT), false, `${dir} 不能指向仓库`);
    assert.equal(fs.existsSync(dir), true, "目录需预建，避免 moveIntoPlace 失败");
  }
});

test("VU-57：容器与 CI 基线文件齐备且包含关键约束", () => {
  const repoRoot = path.join(__dirname, "..", "..");
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /CMD \["node", "server\/src\/index\.js"\]/);
  assert.match(dockerfile, /VOLUME/);

  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "ci.yml"),
    "utf8"
  );
  assert.match(workflow, /npm run ci/);
  assert.match(workflow, /docker build/);

  const rootPkg = require("../../package.json");
  assert.match(rootPkg.scripts.ci, /test:server/);
  assert.match(rootPkg.scripts.ci, /build/);
});
