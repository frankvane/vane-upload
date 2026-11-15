// VU-44：global 配额强一致回归。
// 改造后「读三维度用量 → 校验 → 落库」整体在 quota:global 锁内原子执行，
// 因此跨用户并发上传也绝不超卖全局总容量。本文件验证两条不变量：
//  ① 并发 N 路上传（不同用户/不同文件）对全局分片数上限，精确恰好 K 个通过；
//  ② 全局锁中途耗尽：后到的不同用户请求在锁释放后以精确 400 拒绝，且未被落库（无超卖）。
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "secure";
process.env.FILE_AUTH_TOKEN = "gq-a,gq-b,gq-c,gq-d,gq-e,gq-f,gq-g,gq-h";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";
// 单文件 / 单用户上限放很大，使全局维度成为唯一瓶颈。
process.env.MAX_UPLOAD_SIZE_MB = "100";
process.env.MAX_CHUNKS = "1000";
process.env.MAX_USER_UPLOAD_SIZE_MB = "100";
process.env.MAX_USER_CHUNKS = "1000";
process.env.MAX_TOTAL_UPLOAD_SIZE_MB = "100";

const testDbStorage = path.join(
  os.tmpdir(),
  `rui-test-global-quota-${process.pid}.sqlite`
);
process.env.DB_STORAGE = testDbStorage;
process.env.SERVER_TMP_UPLOAD_DIR = path.join(
  os.tmpdir(),
  `rui-global-quota-${process.pid}`
);

const app = require("../src/app");
const { syncModels, sequelize, FileChunk } = require("../src/models");

const auth = (token) => ({ Authorization: `Bearer ${token}` });

const uploadChunk = (token, fileId, index, buffer) =>
  request(app)
    .post("/api/file/upload")
    .set(auth(token))
    .field("file_id", fileId)
    .field("index", String(index))
    .attach("chunk", buffer, { filename: `${fileId}.bin` });

test.before(async () => {
  await syncModels({ force: true });
});

// 每个用例独立：上一用例写入的分片会占用全局计数，必须清库后再设各自的全局上限。
test.beforeEach(async () => {
  await FileChunk.destroy({ where: {}, truncate: true });
});

test.after(async () => {
  await sequelize.close();
});

// ① 并发跨用户：全局分片数上限 = 3，5 个不同用户各传 1 片，必须恰好 3 个 200 + 2 个 400。
test("VU-44：并发 5 路跨用户上传对全局分片数上限恰好 3 通过", async () => {
  process.env.MAX_TOTAL_CHUNKS = "3";
  const tokens = ["gq-a", "gq-b", "gq-c", "gq-d", "gq-e"];
  const results = await Promise.all(
    tokens.map((tok, i) =>
      uploadChunk(tok, `gc-${i}`, 0, Buffer.alloc(10, 0x30 + i))
    )
  );

  assert.equal(
    results.filter((r) => r.status === 200).length,
    3,
    "并发 5 路必须恰好 3 路通过全局配额校验"
  );
  assert.equal(
    results.filter((r) => r.status === 400).length,
    2,
    "其余 2 路必须被精确拒绝"
  );
  assert.deepEqual(
    results.filter((r) => r.status === 400).map((r) => r.body.message),
    Array(2).fill("分片存储配额已用尽"),
    "2 个拒绝都必须精确命中全局分片数上限"
  );
  results
    .filter((r) => r.status === 200)
    .forEach((r) => assert.equal(r.body.code, 200));
});

// ② 中途耗尽：阻塞首个全局 flush，让不同用户的后到请求在全局锁上排队；
//    释放后，后到请求读到已打满的全局用量，以精确 400 拒绝，且不触发第二次落库（无超卖）。
test("VU-44：全局锁中途耗尽——后到不同用户请求以精确 400 拒绝且无超卖", async () => {
  process.env.MAX_TOTAL_CHUNKS = "1";
  const originalBulkCreate = FileChunk.bulkCreate;
  let signalFirst;
  const firstFlushReached = new Promise((resolve) => {
    signalFirst = resolve;
  });
  let releaseFirst;
  const releaseGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  FileChunk.bulkCreate = async (...args) => {
    calls += 1;
    if (calls === 1) {
      signalFirst();
      await releaseGate;
    }
    return originalBulkCreate.apply(FileChunk, args);
  };

  try {
    // 先到请求：进入全局锁并停在首次 flush（持锁）。
    const first = uploadChunk("gq-f", "gd-1", 0, Buffer.alloc(10, 1)).then(
      (r) => r
    );
    await firstFlushReached;
    // 后到请求：另一用户另一文件，写盘后会在全局锁上排队（被先到者阻塞）。
    const second = uploadChunk("gq-g", "gd-2", 0, Buffer.alloc(10, 2)).then(
      (r) => r
    );
    releaseFirst();
    const [firstRes, secondRes] = await Promise.all([first, second]);

    assert.equal(firstRes.status, 200, "先到的请求应成功落盘");
    assert.equal(firstRes.body.code, 200);
    assert.equal(secondRes.status, 400, "后到的请求必须撞上已耗尽的全局配额");
    assert.equal(secondRes.body.message, "分片存储配额已用尽");
    assert.equal(calls, 1, "被拒绝的请求不得再触发落库（无超卖）");
  } finally {
    FileChunk.bulkCreate = originalBulkCreate;
  }
});
