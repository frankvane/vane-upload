// P2-9：多租户隔离——身份来自鉴权凭据，秒传 / 合并都按用户维度隔离。
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "secure";
process.env.FILE_AUTH_TOKEN = "tenant-token-a,tenant-token-b";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";

const testDbStorage = path.join(
  os.tmpdir(),
  `rui-test-tenant-${process.pid}.sqlite`
);
process.env.DB_STORAGE = testDbStorage;
process.env.SERVER_TMP_UPLOAD_DIR = path.join(
  os.tmpdir(),
  `rui-tenant-upload-${process.pid}`
);

const app = require("../src/app");
const { syncModels, sequelize, File } = require("../src/models");
const { md5Buffer } = require("../src/utils/hash");
const { buildPrincipalId } = require("../src/middleware/auth");
const { UPLOADS_DIR } = require("../src/config/paths");

const TOKEN_A = "tenant-token-a";
const TOKEN_B = "tenant-token-b";
const USER_A = buildPrincipalId(TOKEN_A);
const USER_B = buildPrincipalId(TOKEN_B);

const auth = (token) => ({ Authorization: `Bearer ${token}` });

const content = Buffer.from("tenant-isolation-payload");
const fileMd5 = md5Buffer(content);
const chunkSize = content.length;
const fileId = `${fileMd5}_${content.length}_${chunkSize}`;

const uploadAs = (token, index, buffer) =>
  request(app)
    .post("/api/file/upload")
    .set(auth(token))
    .field("file_id", fileId)
    .field("index", String(index))
    .field("chunk_md5", md5Buffer(buffer))
    .attach("chunk", buffer, { filename: `${fileId}.bin` });

test.before(async () => {
  await syncModels({ force: true });
});

test.after(async () => {
  const rows = await File.findAll({ where: { md5: fileMd5 } });
  await sequelize.close();
  for (const row of rows) {
    if (!row.file_path) continue;
    const absolute = path.resolve(
      path.join(UPLOADS_DIR, path.basename(row.file_path))
    );
    if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
  }
});

test("P2-9：user_id 由鉴权身份派生，请求体 user_id 被忽略", async () => {
  assert.equal((await uploadAs(TOKEN_A, 0, content)).status, 200);

  const merged = await request(app)
    .post("/api/file/merge")
    .set(auth(TOKEN_A))
    // 伪造归属：服务端必须忽略
    .send({
      file_id: fileId,
      md5: fileMd5,
      name: "tenant-a.bin",
      size: content.length,
      total: 1,
      user_id: USER_B,
    });

  assert.equal(merged.status, 200);
  const row = await File.findOne({
    where: { file_id: `${USER_A}:${fileId}`, user_id: USER_A },
  });
  assert.ok(row, "应按凭据派生身份写入 user_id");
  assert.equal(row.user_id, USER_A);
  assert.notEqual(row.user_id, USER_B);
});

test("P2-9：其他用户秒传不命中", async () => {
  // A 已合并；B 上传同一内容应拿不到秒传命中
  const instant = await request(app)
    .post("/api/file/instant")
    .set(auth(TOKEN_B))
    .send({
      file_id: fileId,
      md5: fileMd5,
      name: "tenant-a.bin",
      size: content.length,
      total: 1,
      chunk_size: chunkSize,
    });

  assert.equal(instant.status, 200);
  assert.equal(instant.body.data.uploaded, false, "跨用户不得秒传命中");
});

test("P2-9：同一内容不同用户各自持有独立 File 记录", async () => {
  // B 重新上传同一内容（chunks 已在 A 合并时删除，需要重传）
  assert.equal((await uploadAs(TOKEN_B, 0, content)).status, 200);
  const mergedB = await request(app)
    .post("/api/file/merge")
    .set(auth(TOKEN_B))
    .send({
      file_id: fileId,
      md5: fileMd5,
      name: "tenant-b.bin",
      size: content.length,
      total: 1,
    });
  assert.equal(mergedB.status, 200);

  const rows = await File.findAll({ where: { md5: fileMd5 } });
  const owners = rows.map((row) => row.user_id).sort();
  assert.deepEqual(owners, [USER_A, USER_B].sort(), "两个用户各自保留一条归属记录");
  const rowIds = rows.map((row) => row.file_id).sort();
  assert.deepEqual(
    rowIds,
    [`${USER_A}:${fileId}`, `${USER_B}:${fileId}`].sort(),
    "file_id 按用户命名空间隔离"
  );
});
