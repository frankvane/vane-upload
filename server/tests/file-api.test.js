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
const { buildChunkPath, buildScopedFileId } = require("../src/utils/fileSecurity");

// demo 模式下 userId 固定为 "test"；存储键已按用户命名空间隔离（VU-01/02）。
const scoped = (fileId) => buildScopedFileId("test", fileId);
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

test("POST /api/file/instant 返回标准三段式响应（code/message/data），且未上传文件 uploaded=false", async () => {
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
  // 该 file_id 尚未上传任何分片，应判定为未秒传
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

  // VU-04：uploadChunk 现在写盘后同步落库（await flushFileChunkStates），
  // 因此上传完成即可在 DB 查到 status=1 的分片，无需等待合并时的 flush。
  const queuedCount = await FileChunk.count({
    where: { file_id: scoped(fileId), status: 1 },
  });
  assert.equal(queuedCount, 1);

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
    where: { file_id: scoped(fileId), status: 2 },
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

  const chunkPath = buildChunkPath(scoped(fileId), 0);
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

  // VU-61：目录已隔离到临时卷，不能再用 __dirname/../uploads 硬拼。
  const firstAbsolute = path.join(UPLOADS_DIR, path.basename(firstPhysical));
  const secondAbsolute = path.join(UPLOADS_DIR, path.basename(secondPhysical));
  assert.equal(fs.existsSync(firstAbsolute), true);
  assert.equal(fs.existsSync(secondAbsolute), true);

  const firstBuffer = fs.readFileSync(firstAbsolute);
  const secondBuffer = fs.readFileSync(secondAbsolute);
  assert.equal(md5Buffer(firstBuffer), first.chunkMd5);
  assert.equal(md5Buffer(secondBuffer), second.chunkMd5);
});

test("E2E-03：POST /api/file/abort 清理残留分片，删除后不会被合并落盘", async () => {
  const chunkBuffer = Buffer.from("abort-chunk-payload", "utf8");
  const chunkMd5 = md5Buffer(chunkBuffer);
  const fileId = "abort_case_file";

  const uploadRes = await request(app)
    .post("/api/file/upload")
    .field("file_id", fileId)
    .field("index", "0")
    .field("chunk_md5", chunkMd5)
    .attach("chunk", chunkBuffer, { filename: "chunk-0.bin" });
  assert.equal(uploadRes.status, 200);

  const chunkPath = buildChunkPath(scoped(fileId), 0);
  assert.equal(fs.existsSync(chunkPath), true);

  const abortRes = await request(app)
    .post("/api/file/abort")
    .send({ file_id: fileId });
  assert.equal(abortRes.status, 200);
  assert.equal(abortRes.body.data.cleared, 1);
  assert.equal(fs.existsSync(chunkPath), false, "分片文件必须被删除");

  const statusRes = await request(app)
    .get("/api/file/status")
    .query({ file_id: fileId, md5: "unused-in-status-check" });
  assert.deepEqual(statusRes.body.data.chunks, [], "分片状态必须被清空");

  // 已删除的分片不能再被合并落盘。
  const mergeRes = await request(app).post("/api/file/merge").send({
    file_id: fileId,
    md5: chunkMd5,
    name: "aborted.bin",
    size: chunkBuffer.length,
    total: 1,
  });
  assert.equal(mergeRes.status, 400);

  const mergedFile = await File.findOne({
    where: { md5: chunkMd5, size: chunkBuffer.length, status: 1 },
  });
  assert.equal(mergedFile, null, "已删除的上传不得产生落盘文件");
});

test("E2E-03：POST /api/file/abort 幂等，缺少 file_id 时返回 400", async () => {
  const emptyRes = await request(app)
    .post("/api/file/abort")
    .send({ file_id: "abort_none_file" });
  assert.equal(emptyRes.status, 200);
  assert.equal(emptyRes.body.data.cleared, 0);

  const missingRes = await request(app).post("/api/file/abort").send({});
  assert.equal(missingRes.status, 400);
});

// T-38：abort 与 merge 并发。让 merge 稳定停在「读第 0 个分片」处（此时它已持有
// 合并锁、整个读片→落盘→清理周期尚未结束），再发起 abort，构造「合并进行中删源分片」。
// 期望：要么 merge 完整成功、要么 abort 明确 409；不得出现 ENOENT 崩溃，也不得出现
// 「产物已落盘 + FileChunk 归零」的状态分裂。
test("T-38：abort × merge 并发，合并成功或明确 409，无 ENOENT / 状态分裂", async () => {
  const chunkBuffer = Buffer.from("t38-abort-merge-payload", "utf8");
  const chunkMd5 = md5Buffer(chunkBuffer);
  const fileId = "t38_abort_merge_file";
  const fileName = "t38-abort-merge.bin";
  const chunkPath = buildChunkPath(scoped(fileId), 0);

  const uploadRes = await request(app)
    .post("/api/file/upload")
    .field("file_id", fileId)
    .field("index", "0")
    .field("chunk_md5", chunkMd5)
    .attach("chunk", chunkBuffer, { filename: "chunk-0.bin" });
  assert.equal(uploadRes.status, 200);

  const originalReadFile = fs.promises.readFile;
  let signalRead;
  const readReached = new Promise((resolve) => {
    signalRead = resolve;
  });
  let releaseRead;
  const readGate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  fs.promises.readFile = async (...args) => {
    if (String(args[0]) === chunkPath) {
      signalRead();
      await readGate;
    }
    return originalReadFile.apply(fs.promises, args);
  };

  let mergeRes;
  let abortRes;
  try {
    // supertest 的 Test 是惰性的，只有 .then/.end 才会真正发请求；
    // 这里立即触发，让 merge 与后续 abort 构成真实并发。
    const mergePromise = request(app)
      .post("/api/file/merge")
      .send({
        file_id: fileId,
        md5: chunkMd5,
        name: fileName,
        size: chunkBuffer.length,
        total: 1,
      })
      .then((res) => res);
    await readReached; // merge 已进入读片临界区，正在合并中
    abortRes = await request(app)
      .post("/api/file/abort")
      .send({ file_id: fileId });
    releaseRead();
    mergeRes = await mergePromise;
  } finally {
    fs.promises.readFile = originalReadFile;
  }

  const mergeOk = mergeRes.status === 200;
  const abortRejected = abortRes.status === 409;
  assert.ok(
    mergeOk || abortRejected,
    `并发结果不干净：merge=${mergeRes.status} (${mergeRes.body?.message}), abort=${abortRes.status}`
  );
  // 源分片被 abort 删掉后 merge 读片会抛 ENOENT → 500，绝不允许。
  assert.ok(
    mergeRes.status < 500,
    `merge 不得因源分片消失而 ENOENT 崩溃：${mergeRes.body?.message}`
  );

  // 状态不变量：产物一旦落盘，该 storageId 下不得残留被 abort 归零（status=0）的分片。
  const produced = await File.findOne({
    where: { md5: chunkMd5, size: chunkBuffer.length, status: 1 },
  });
  if (produced) {
    const zeroed = await FileChunk.count({
      where: { file_id: scoped(fileId), status: 0 },
    });
    assert.equal(
      zeroed,
      0,
      "产物已落盘时不得同时残留被 abort 归零的分片状态"
    );
  }
});
