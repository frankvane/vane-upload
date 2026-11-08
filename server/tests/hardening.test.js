// 第三批加固回归：P1-4（分片累计配额）、P2-8（md5 语义标记）、
// P2-9（秒传脱敏）、P2-10（错误文案脱敏）。
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "demo";
process.env.RATE_LIMIT_ENABLED = "false";
// 收紧到 2KB / 3 片，便于用小载荷触达累计配额
process.env.MAX_UPLOAD_SIZE_MB = "0.002";
process.env.MAX_CHUNKS = "3";
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";

const testDbStorage = path.join(__dirname, "tmp-test-hardening.sqlite");
process.env.DB_STORAGE = testDbStorage;
// 分片目录独立：全局配额用例需要从「空目录」开始播种，避免受其他用例 / 上次运行的残留影响。
// 放 OS 临时目录 + 每进程唯一前缀，且不做递归清理（避免误删仓库文件）。
const testTmpUploadDir = path.join(
  os.tmpdir(),
  `rui-hardening-upload-${process.pid}`
);
process.env.SERVER_TMP_UPLOAD_DIR = testTmpUploadDir;

const app = require("../src/app");
const { syncModels, sequelize, File } = require("../src/models");
const { md5Buffer } = require("../src/utils/hash");
const hashUtils = require("../src/utils/hash");
const { redactErrorMessage } = require("../src/utils/errorMessage");

const uploadChunk = async (fileId, index, buffer) =>
  request(app)
    .post("/api/file/upload")
    .field("file_id", fileId)
    .field("index", String(index))
    .attach("chunk", buffer, { filename: `${fileId}.bin` });

test.before(async () => {
  await syncModels({ force: true });
});

test.after(async () => {
  await sequelize.close();
  if (fs.existsSync(testDbStorage)) fs.unlinkSync(testDbStorage);
  // 清理本文件产生的落盘产物，避免污染仓库 uploads 目录
  const { UPLOADS_DIR } = require("../src/config/paths");
  for (const name of fs.existsSync(UPLOADS_DIR)
    ? fs.readdirSync(UPLOADS_DIR)
    : []) {
    if (name.startsWith("f-dto_")) {
      fs.unlinkSync(path.join(UPLOADS_DIR, name));
    }
  }
});

test("P1-4：全局配额——换 file_id 也无法突破进程总容量", async () => {
  // 不再依赖「最先执行」：每个用例重置 DB，消除顺序依赖（VU-60）。
  await syncModels({ force: true });
  const chunk = Buffer.alloc(600, 0x64);
  process.env.MAX_UPLOAD_SIZE_MB = "0.002"; // 单文件 2KB，够放 3 片
  process.env.MAX_TOTAL_UPLOAD_SIZE_MB = "0.001"; // 全局约 1048B

  try {
    // file_id A 写 1 片（600B）→ 全局 600B，未超限
    assert.equal((await uploadChunk("f-global-a", 0, chunk)).status, 200);

    // 换一个 file_id 再写 600B → 全局 1200B > 1048B，必须被拒
    const other = await uploadChunk("f-global-b", 0, chunk);
    assert.equal(other.status, 413);
    assert.equal(other.body.code, 413);
  } finally {
    delete process.env.MAX_TOTAL_UPLOAD_SIZE_MB;
  }
});

test("P1-4：分片累计字节超过 MAX_UPLOAD_SIZE_MB → 413（不再只在 merge 校验）", async () => {
  const chunk = Buffer.alloc(800, 0x61);

  assert.equal((await uploadChunk("f-quota", 0, chunk)).status, 200);
  assert.equal((await uploadChunk("f-quota", 1, chunk)).status, 200);

  // 累计 2400B > 2KB(2048B) 上限：第三片必须被拒，且不落盘
  const third = await uploadChunk("f-quota", 2, chunk);
  assert.equal(third.status, 413);
  assert.equal(third.body.code, 413);
});

test("P1-4：重复上传同一 index 按差额计费（覆盖写不重复累加）", async () => {
  const chunk = Buffer.alloc(700, 0x62);

  assert.equal((await uploadChunk("f-quota-replace", 0, chunk)).status, 200);
  assert.equal((await uploadChunk("f-quota-replace", 1, chunk)).status, 200);
  // 覆盖 index 0（大小不变）不应把累计量翻倍
  assert.equal((await uploadChunk("f-quota-replace", 0, chunk)).status, 200);
  // 覆盖后累计仍是 1400B，加一片 700B 后 2100B 超限 → 413
  assert.equal((await uploadChunk("f-quota-replace", 2, chunk)).status, 413);
});

test("P2-9：秒传命中只回传必要字段，不泄漏 user_id / file_path / thumbnail_path", async () => {
  const buf = Buffer.from("instant dto payload");
  const md5 = md5Buffer(buf);
  assert.equal((await uploadChunk("f-dto", 0, buf)).status, 200);

  const merged = await request(app).post("/api/file/merge").send({
    file_id: "f-dto",
    name: "dto.bin",
    size: buf.length,
    md5,
    total: 1,
  });
  assert.equal(merged.status, 200);

  const instant = await request(app)
    .post("/api/file/instant")
    .send({ file_id: "f-dto-2", md5, name: "dto2.bin", size: buf.length });

  assert.equal(instant.status, 200);
  assert.equal(instant.body.data.uploaded, true);
  const file = instant.body.data.file;
  assert.ok(file);
  assert.equal(file.md5, md5);
  // 内部字段必须被剔除
  assert.equal("user_id" in file, false, "不得回传 user_id");
  assert.equal("file_path" in file, false, "不得回传 file_path");
  assert.equal("thumbnail_path" in file, false, "不得回传 thumbnail_path");
});

test("VU-56：两套互相矛盾的采样哈希死代码已删除，hash 只保留全量实现", () => {
  // 后端「头 10MB + 尾 1MB」与前端「首/中/尾 4MB + size 文本」口径不同，
  // 保留但零调用的采样函数只会误导后续维护者启用错误比对。
  assert.deepEqual(Object.keys(hashUtils).sort(), ["md5Buffer", "md5File"]);
  assert.equal("getPartialMd5Mode" in hashUtils, false);
  assert.equal("calculatePartialMd5" in hashUtils, false);
  assert.equal("calculatePartialMd5Async" in hashUtils, false);
  assert.equal(fs.existsSync(path.join(__dirname, "../src/utils/thumbnail.js")), false);
});

test("P2-10：生产环境不回传原始 error.message，测试环境保留以便定位", () => {
  const error = new Error("SQLITE_ERROR: no such column: secret_column");
  const original = process.env.NODE_ENV;

  process.env.NODE_ENV = "production";
  assert.equal(redactErrorMessage(error), "internal server error");

  process.env.NODE_ENV = "test";
  assert.equal(redactErrorMessage(error), error.message);

  process.env.NODE_ENV = original;
});

test("P2-9：DB 中确实存有 user_id / file_path，验证上一条断言不是真空", async () => {
  const md5 = md5Buffer(Buffer.from("instant dto payload"));
  const row = await File.findOne({ where: { md5 } });
  assert.ok(row, "合并后应有 DB 记录");
  // 落库 file_id 带用户命名空间（P2-9），对外 DTO 仍回传 chunkKey
  assert.match(row.file_id, /^[^:]+:f-dto$/);
  assert.ok(row.user_id);
  assert.ok(row.file_path);
});
