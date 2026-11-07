// S2（秒传防污染）+ S3（容量 / 分片数上限 DoS 防护）回归测试。
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "demo"; // 功能测试需要开放服务端
process.env.RATE_LIMIT_ENABLED = "false";
// 收紧上限以触发 S3 守卫：单文件 1MB、最多 5 片
process.env.MAX_UPLOAD_SIZE_MB = "1";
process.env.MAX_CHUNKS = "5";

const testDbStorage = path.join(__dirname, "tmp-test-upload-security.sqlite");
process.env.DB_STORAGE = testDbStorage;
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";

const app = require("../src/app");
const { syncModels, sequelize } = require("../src/models");
const { md5Buffer } = require("../src/utils/hash");
const { UPLOADS_DIR, TMP_UPLOAD_DIR } = require("../src/config/paths");

const uploadChunk = async (fileId, index, buffer) => {
  const res = await request(app)
    .post("/api/file/upload")
    .field("file_id", fileId)
    .field("index", String(index))
    .attach("chunk", buffer, { filename: `${fileId}.bin` });
  return res;
};

const merge = async ({ fileId, size, md5, total }) =>
  request(app)
    .post("/api/file/merge")
    .send({ file_id: fileId, name: "sec.bin", size, md5, total });

test.before(async () => {
  await syncModels({ force: true });
});

test.after(async () => {
  await sequelize.close();
  if (fs.existsSync(testDbStorage)) fs.unlinkSync(testDbStorage);
});

test("S3：声明 size 超过 MAX_UPLOAD_SIZE_MB → 413", async () => {
  const res = await merge({
    fileId: "f-limit-size",
    size: 2 * 1024 * 1024, // 2MB > 1MB 上限
    md5: "a".repeat(32),
    total: 1,
  });
  assert.equal(res.status, 413);
});

test("S3：声明 total 超过 MAX_CHUNKS → 400", async () => {
  const res = await merge({
    fileId: "f-limit-chunks",
    size: 100,
    md5: "a".repeat(32),
    total: 9999, // > 5
  });
  assert.equal(res.status, 400);
});

test("P0-2：md5 含路径分隔符 → 400（不得进入落盘路径拼接）", async () => {
  const buf = Buffer.from("path traversal attempt");
  const up = await uploadChunk("f-traversal", 0, buf);
  assert.equal(up.status, 200);
  const res = await merge({
    fileId: "f-traversal",
    size: buf.length,
    md5: "../../../evil",
    total: 1,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.message, "invalid md5");
});

test("P0-2：md5 非 32 位十六进制 → 400", async () => {
  const res = await merge({
    fileId: "f-bad-md5-format",
    size: 10,
    md5: "not-a-valid-md5",
    total: 1,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.message, "invalid md5");
});

test("S3：上传分片 index 为负 → 400", async () => {
  const res = await uploadChunk("f-neg-index", -1, Buffer.from("hi"));
  assert.equal(res.status, 400);
});

test("S3：上传分片 index 超过 MAX_CHUNKS → 400", async () => {
  const res = await uploadChunk("f-big-index", 10, Buffer.from("hi")); // 10 > 5
  assert.equal(res.status, 400);
});

test("S2：合并后真实 md5 与声明 md5 不符 → 422（防污染）", async () => {
  const buf = Buffer.from("hello world payload for integrity check");
  const up = await uploadChunk("f-bad-md5", 0, buf);
  assert.equal(up.status, 200);
  const res = await merge({
    fileId: "f-bad-md5",
    size: buf.length,
    md5: "deadbeefdeadbeefdeadbeefdeadbeef", // 故意错误
    total: 1,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 422);
});

test("P1-2：合并失败时目标目录不出现半成品，staging 文件被清理", async () => {
  const buf = Buffer.from("partial merge must never be visible");
  const up = await uploadChunk("f-staging-fail", 0, buf);
  assert.equal(up.status, 200);

  const wrongMd5 = "b".repeat(32);
  const res = await merge({
    fileId: "f-staging-fail",
    size: buf.length,
    md5: wrongMd5,
    total: 1,
  });
  assert.equal(res.status, 422);

  const storedName = `f-staging-fail_${wrongMd5}.bin`;
  assert.equal(
    fs.existsSync(path.join(UPLOADS_DIR, storedName)),
    false,
    "校验失败的文件不得出现在 uploads 目录"
  );
  const leftovers = fs
    .readdirSync(TMP_UPLOAD_DIR)
    .filter((name) => name.startsWith(storedName));
  assert.deepEqual(leftovers, [], "staging 临时文件必须被清理");
});

test("P1-2：合并成功后原子移入 uploads，tmp 无 .part 残留", async () => {
  const buf = Buffer.from("atomic publish payload");
  const realMd5 = md5Buffer(buf);
  const up = await uploadChunk("f-staging-ok", 0, buf);
  assert.equal(up.status, 200);

  const res = await merge({
    fileId: "f-staging-ok",
    size: buf.length,
    md5: realMd5,
    total: 1,
  });
  assert.equal(res.status, 200);

  const storedName = `f-staging-ok_${realMd5}.bin`;
  const storedPath = path.join(UPLOADS_DIR, storedName);
  assert.equal(fs.existsSync(storedPath), true);
  assert.equal(fs.readFileSync(storedPath).length, buf.length);

  const leftovers = fs
    .readdirSync(TMP_UPLOAD_DIR)
    .filter((name) => name.startsWith(storedName));
  assert.deepEqual(leftovers, [], ".part 不应残留在 tmp 目录");

  fs.unlinkSync(storedPath);
});

test("S2：合并后文件体积与声明 size 不符 → 422", async () => {
  const buf = Buffer.from("size mismatch payload");
  const up = await uploadChunk("f-bad-size", 0, buf);
  assert.equal(up.status, 200);
  const res = await merge({
    fileId: "f-bad-size",
    size: buf.length + 100, // 声明偏大
    md5: md5Buffer(buf),
    total: 1,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 422);
});

test("S2：合法 full-md5 合并成功且可秒传（不破坏正常链路）", async () => {
  const buf = Buffer.from("valid content for happy path");
  const realMd5 = md5Buffer(buf);
  const up = await uploadChunk("f-ok", 0, buf);
  assert.equal(up.status, 200);
  const res = await merge({
    fileId: "f-ok",
    size: buf.length,
    md5: realMd5,
    total: 1,
  });
  assert.equal(res.status, 200);

  // 秒传：相同 md5+size 应命中
  const instant = await request(app)
    .post("/api/file/instant")
    .send({
      file_id: "f-ok-2",
      md5: realMd5,
      name: "f-ok-2.bin",
      size: buf.length,
    });
  assert.equal(instant.status, 200);
  assert.equal(instant.body.code, 200);
  assert.equal(instant.body.data.uploaded, true);

  // 清理落盘产物，避免测试反复跑污染仓库 uploads 目录
  fs.rmSync(path.join(UPLOADS_DIR, `f-ok_${realMd5}.bin`), { force: true });
});
