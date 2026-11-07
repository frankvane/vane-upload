const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

process.env.NODE_ENV = "test";
const testDbStorage = path.join(__dirname, "tmp-test.sqlite");
process.env.DB_STORAGE = testDbStorage;
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";
// 功能测试需要开放的服务端，显式关闭鉴权（默认 AUTH_MODE=secure 会 fail-closed）
process.env.AUTH_MODE = "demo";
// 显式关闭限流，避免与其他测试文件的全局 env 相互覆盖导致偶发 429
process.env.RATE_LIMIT_ENABLED = "false";

const app = require("../src/app");
const { syncModels, sequelize, File, FileChunk } = require("../src/models");
const { TMP_UPLOAD_DIR, UPLOADS_DIR, ensureBaseDirs } = require("../src/config/paths");
const { md5Buffer } = require("../src/utils/hash");
const { buildChunkPath } = require("../src/utils/fileSecurity");
const {
  flushPendingChunkStates,
  resetChunkStateQueueForTests,
} = require("../src/services/chunkStateQueue");

const uploadAndMergeSingleChunk = async ({ fileId, fileName, content }) => {
  const chunkBuffer = Buffer.from(content, "utf8");
  const chunkMd5 = md5Buffer(chunkBuffer);

  const uploadRes = await request(app)
    .post("/api/file/upload")
    .field("file_id", fileId)
    .field("index", "0")
    .field("chunk_md5", chunkMd5)
    .attach("chunk", chunkBuffer, { filename: `${fileId}.bin` });
  assert.equal(uploadRes.status, 200);
  assert.equal(uploadRes.body.code, 200);

  const mergeRes = await request(app).post("/api/file/merge").send({
    file_id: fileId,
    md5: chunkMd5,
    name: fileName,
    size: chunkBuffer.length,
    total: 1,
  });
  assert.equal(mergeRes.status, 200);
  assert.equal(mergeRes.body.code, 200);

  return { chunkBuffer, chunkMd5 };
};

test.before(async () => {
  ensureBaseDirs();
  if (fs.existsSync(testDbStorage)) fs.unlinkSync(testDbStorage);
  await syncModels({ force: true });
});

test.beforeEach(async () => {
  await resetChunkStateQueueForTests();
});

test.after(async () => {
  await resetChunkStateQueueForTests();
  await sequelize.close();

  const tmpFiles = fs.readdirSync(TMP_UPLOAD_DIR);
  for (const name of tmpFiles) {
    fs.unlinkSync(path.join(TMP_UPLOAD_DIR, name));
  }

  const uploadFiles = fs.readdirSync(UPLOADS_DIR);
  for (const name of uploadFiles) {
    fs.unlinkSync(path.join(UPLOADS_DIR, name));
  }

  if (fs.existsSync(testDbStorage)) fs.unlinkSync(testDbStorage);
});

test("POST /api/file/instant returns standard response shape", async () => {
  const res = await request(app).post("/api/file/instant").send({
    file_id: "demo_file_1",
    md5: "abc",
    name: "demo.txt",
    size: 3,
    chunk_md5s: [],
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.code, 200);
  assert.equal(typeof res.body.message, "string");
  assert.equal(typeof res.body.data, "object");
  assert.equal(res.body.data.uploaded, false);
});

test("POST /api/file/upload + GET /api/file/status works for chunk state query", async () => {
  const chunkBuffer = Buffer.from("hello-chunk", "utf8");
  const chunkMd5 = md5Buffer(chunkBuffer);
  const fileId = "status_case_file";

  const uploadRes = await request(app)
    .post("/api/file/upload")
    .field("file_id", fileId)
    .field("index", "0")
    .field("chunk_md5", chunkMd5)
    .attach("chunk", chunkBuffer, { filename: "chunk-0.bin" });

  assert.equal(uploadRes.status, 200);
  assert.equal(uploadRes.body.code, 200);

  const statusRes = await request(app)
    .get("/api/file/status")
    .query({ file_id: fileId, md5: "unused-in-status-check" });

  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.code, 200);
  assert.deepEqual(statusRes.body.data.chunks, [0]);
});

test("queued chunk state flush retries SQLITE_BUSY and succeeds", async () => {
  const chunkBuffer = Buffer.from("busy-retry-case", "utf8");
  const chunkMd5 = md5Buffer(chunkBuffer);
  const fileId = "busy_retry_file";

  const originalBulkCreate = FileChunk.bulkCreate;
  let calls = 0;
  FileChunk.bulkCreate = async (...args) => {
    calls += 1;
    if (calls === 1) {
      throw new Error("SQLITE_BUSY: database is locked");
    }
    return originalBulkCreate.apply(FileChunk, args);
  };

  try {
    const uploadRes = await request(app)
      .post("/api/file/upload")
      .field("file_id", fileId)
      .field("index", "0")
      .field("chunk_md5", chunkMd5)
      .attach("chunk", chunkBuffer, { filename: "chunk-0.bin" });

    assert.equal(uploadRes.status, 200);
    assert.equal(uploadRes.body.code, 200);

    await flushPendingChunkStates();
    assert.ok(calls >= 2);
  } finally {
    FileChunk.bulkCreate = originalBulkCreate;
  }
});

test("merge flushes queued chunk states before merge validation", async () => {
  const chunkBuffer = Buffer.from("merge-queued-state", "utf8");
  const chunkMd5 = md5Buffer(chunkBuffer);
  const fileId = "merge_flush_file";
  const fileName = "merge-flush.bin";

  const uploadRes = await request(app)
    .post("/api/file/upload")
    .field("file_id", fileId)
    .field("index", "0")
    .field("chunk_md5", chunkMd5)
    .attach("chunk", chunkBuffer, { filename: "chunk-0.bin" });

  assert.equal(uploadRes.status, 200);
  assert.equal(uploadRes.body.code, 200);

  const queuedCount = await FileChunk.count({
    where: { file_id: fileId, status: 1 },
  });
  assert.equal(queuedCount, 0);

  const mergeRes = await request(app).post("/api/file/merge").send({
    file_id: fileId,
    md5: chunkMd5,
    name: fileName,
    size: chunkBuffer.length,
    total: 1,
  });

  assert.equal(mergeRes.status, 200);
  assert.equal(mergeRes.body.code, 200);

  const mergedChunkCount = await FileChunk.count({
    where: { file_id: fileId, status: 2 },
  });
  assert.equal(mergedChunkCount, 1);
});

test("stale chunks are excluded by /instant and /status", async () => {
  const chunkBuffer = Buffer.from("stale-chunk-case", "utf8");
  const chunkMd5 = md5Buffer(chunkBuffer);
  const fileId = "stale_chunk_file";

  const uploadRes = await request(app)
    .post("/api/file/upload")
    .field("file_id", fileId)
    .field("index", "0")
    .field("chunk_md5", chunkMd5)
    .attach("chunk", chunkBuffer, { filename: "chunk-0.bin" });

  assert.equal(uploadRes.status, 200);
  assert.equal(uploadRes.body.code, 200);

  const chunkPath = buildChunkPath(fileId, 0);
  assert.equal(fs.existsSync(chunkPath), true);
  fs.unlinkSync(chunkPath);

  const instantRes = await request(app).post("/api/file/instant").send({
    file_id: fileId,
    md5: "dummy",
    name: "stale.bin",
    size: chunkBuffer.length,
    chunk_md5s: [chunkMd5],
  });

  assert.equal(instantRes.status, 200);
  assert.equal(instantRes.body.code, 200);
  assert.deepEqual(instantRes.body.data.chunkCheckResult, [
    { index: 0, exist: false, match: false },
  ]);

  const statusRes = await request(app)
    .get("/api/file/status")
    .query({ file_id: fileId, md5: "unused-in-status-check" });

  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.code, 200);
  assert.deepEqual(statusRes.body.data.chunks, []);
});

test("merge stores same-name uploads with distinct physical files", async () => {
  const sharedName = "same-name-upload.txt";

  const first = await uploadAndMergeSingleChunk({
    fileId: "merge_same_name_a",
    fileName: sharedName,
    content: "first-version",
  });
  const second = await uploadAndMergeSingleChunk({
    fileId: "merge_same_name_b",
    fileName: sharedName,
    content: "second-version",
  });

  const mergedFiles = await File.findAll({
    where: { file_name: sharedName, status: 1 },
    order: [["file_id", "ASC"]],
  });

  assert.equal(mergedFiles.length, 2);

  const firstPhysical = mergedFiles[0].file_path;
  const secondPhysical = mergedFiles[1].file_path;
  assert.notEqual(firstPhysical, secondPhysical);

  const firstAbsolute = path.join(__dirname, "..", firstPhysical);
  const secondAbsolute = path.join(__dirname, "..", secondPhysical);
  assert.equal(fs.existsSync(firstAbsolute), true);
  assert.equal(fs.existsSync(secondAbsolute), true);

  const firstBuffer = fs.readFileSync(firstAbsolute);
  const secondBuffer = fs.readFileSync(secondAbsolute);
  assert.equal(md5Buffer(firstBuffer), first.chunkMd5);
  assert.equal(md5Buffer(secondBuffer), second.chunkMd5);
});
