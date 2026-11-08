// VU-01 / VU-02 回归：分片存储与落盘文件必须按用户命名空间隔离。
// 这些用例直接断言磁盘与 DB，而不只是 HTTP 状态码。
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rui-storage-iso-"));
process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "secure";
process.env.FILE_AUTH_TOKEN = "iso-token-a,iso-token-b";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";
process.env.DB_STORAGE = path.join(testRoot, "db.sqlite");
process.env.SERVER_TMP_UPLOAD_DIR = path.join(testRoot, "tmp");
process.env.SERVER_UPLOADS_DIR = path.join(testRoot, "uploads");

const app = require("../src/app");
const { syncModels, sequelize, File, FileChunk } = require("../src/models");
const { md5Buffer } = require("../src/utils/hash");
const {
  buildScopedFileId,
  buildChunkPath,
} = require("../src/utils/fileSecurity");
const { buildPrincipalId } = require("../src/middleware/auth");
const { UPLOADS_DIR, ensureBaseDirs } = require("../src/config/paths");
const {
  flushPendingChunkStates,
  resetChunkStateQueueForTests,
} = require("../src/services/chunkStateQueue");

const TOKEN_A = "iso-token-a";
const TOKEN_B = "iso-token-b";
const USER_A = buildPrincipalId(TOKEN_A);
const USER_B = buildPrincipalId(TOKEN_B);
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const contentA = Buffer.from("isolation-payload-A");
const contentB = Buffer.from("isolation-payload-B-xx");
const md5A = md5Buffer(contentA);
const md5B = md5Buffer(contentB);
const chunkSize = Math.max(contentA.length, contentB.length);
const fileId = `${md5A}_${contentA.length}_${chunkSize}`;

const uploadAs = (token, id, index, buffer) =>
  request(app)
    .post("/api/file/upload")
    .set(auth(token))
    .field("file_id", id)
    .field("index", String(index))
    .field("chunk_md5", md5Buffer(buffer))
    .attach("chunk", buffer, { filename: `chunk-${index}.bin` });

const statusAs = (token, id) =>
  request(app)
    .get("/api/file/status")
    .set(auth(token))
    .query({ file_id: id, md5: "probe" });

test.before(async () => {
  ensureBaseDirs();
  await syncModels({ force: true });
});

// 注意：不重置 chunkStateQueue。分片状态是异步批量落库的，
// 跨用例保留 pending 才能真实模拟「上传完立刻合并」的时序。

test.after(async () => {
  await resetChunkStateQueueForTests();
  await sequelize.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("VU-02：B 不能通过 /status 或 /instant 读到 A 的上传进度", async () => {
  assert.equal((await uploadAs(TOKEN_A, fileId, 0, contentA)).status, 200);

  const statusB = await statusAs(TOKEN_B, fileId);
  assert.equal(statusB.status, 200);
  assert.deepEqual(statusB.body.data.chunks, [], "跨用户不得看到分片进度");

  const instantB = await request(app)
    .post("/api/file/instant")
    .set(auth(TOKEN_B))
    .send({
      file_id: fileId,
      md5: md5A,
      name: "iso.bin",
      size: contentA.length,
      chunk_md5s: [md5A],
    });
  assert.equal(instantB.status, 200);
  assert.deepEqual(instantB.body.data.chunkCheckResult, [
    { index: 0, exist: false, match: false },
  ]);

  const statusA = await statusAs(TOKEN_A, fileId);
  assert.deepEqual(statusA.body.data.chunks, [0], "A 自己的进度仍可见");
});

test("VU-02：B 用 A 的 file_id 上传分片不会覆盖 A 的分片字节", async () => {
  const pathA = buildChunkPath(buildScopedFileId(USER_A, fileId), 0);
  const pathB = buildChunkPath(buildScopedFileId(USER_B, fileId), 0);
  assert.notEqual(pathA, pathB, "存储键必须按用户隔离");
  assert.equal(fs.readFileSync(pathA).equals(contentA), true);

  assert.equal((await uploadAs(TOKEN_B, fileId, 0, contentB)).status, 200);

  assert.equal(fs.readFileSync(pathA).equals(contentA), true, "A 的分片未被覆盖");
  assert.equal(fs.readFileSync(pathB).equals(contentB), true, "B 写入自己的分片");

  await flushPendingChunkStates();
  const rawRows = await FileChunk.count({ where: { file_id: fileId } });
  assert.equal(rawRows, 0, "FileChunk.file_id 不得再存裸客户端键");
  const rowsA = await FileChunk.count({
    where: { file_id: buildScopedFileId(USER_A, fileId), user_id: USER_A },
  });
  const rowsB = await FileChunk.count({
    where: { file_id: buildScopedFileId(USER_B, fileId), user_id: USER_B },
  });
  assert.equal(rowsA, 1, "A 的分片行按用户命名空间独立存在");
  assert.equal(rowsB, 1, "B 的分片行按用户命名空间独立存在");
});

test("VU-01：B 的失败合并不会删除 A 已成功落盘的文件", async () => {
  const mergeA = await request(app)
    .post("/api/file/merge")
    .set(auth(TOKEN_A))
    .send({
      file_id: fileId,
      md5: md5A,
      name: "isolation-a.bin",
      size: contentA.length,
      total: 1,
    });
  assert.equal(mergeA.status, 200);

  const rowA = await File.findOne({
    where: { file_id: `${USER_A}:${fileId}`, user_id: USER_A },
  });
  assert.ok(rowA?.file_path);
  const absoluteA = path.join(UPLOADS_DIR, path.basename(rowA.file_path));
  assert.equal(fs.existsSync(absoluteA), true);
  assert.equal(fs.readFileSync(absoluteA).equals(contentA), true);

  // B 用与 A 完全相同的 file_id（修复前两者落盘路径相同）+ 故意错误的
  // size 触发合并校验失败。这正是旧实现里 catch 误删他人文件的攻击路径。
  const mergeB = await request(app)
    .post("/api/file/merge")
    .set(auth(TOKEN_B))
    .send({
      file_id: fileId,
      md5: md5B,
      name: "isolation-b.bin",
      size: contentB.length + 1,
      total: 1,
    });
  assert.equal(mergeB.status, 422);

  assert.equal(
    fs.existsSync(absoluteA),
    true,
    "A 的文件必须仍在磁盘上（失败清理不得删他人文件）"
  );
  const instantA = await request(app)
    .post("/api/file/instant")
    .set(auth(TOKEN_A))
    .send({
      file_id: fileId,
      md5: md5A,
      name: "isolation-a.bin",
      size: contentA.length,
    });
  assert.equal(instantA.body.data.uploaded, true, "A 的 DB 记录仍可用");
});
