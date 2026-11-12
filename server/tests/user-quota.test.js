// P1-4：user 维度分片配额——同一凭据更换 file_id 仍受限。
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "secure";
process.env.FILE_AUTH_TOKEN = "quota-a,quota-b,quota-c,quota-d";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";
// 约 1048 字节 / 1 个分片的用户配额，便于用小请求触发
process.env.MAX_USER_UPLOAD_SIZE_MB = "0.001";
process.env.MAX_USER_CHUNKS = "1";

const testDbStorage = path.join(
  os.tmpdir(),
  `rui-test-user-quota-${process.pid}.sqlite`
);
process.env.DB_STORAGE = testDbStorage;
process.env.SERVER_TMP_UPLOAD_DIR = path.join(
  os.tmpdir(),
  `rui-user-quota-${process.pid}`
);

const app = require("../src/app");
const { syncModels, sequelize } = require("../src/models");

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

test.after(async () => {
  await sequelize.close();
});

test("P1-4：同一用户更换 file_id 仍受累计字节配额限制", async () => {
  const first = await uploadChunk("quota-a", "q-a-1", 0, Buffer.alloc(200, 1));
  assert.equal(first.status, 200);

  // 换一个 file_id 继续写：200 + 2000 超过 ~1048 字节的用户上限
  const second = await uploadChunk(
    "quota-a",
    "q-a-2",
    0,
    Buffer.alloc(2000, 2)
  );
  assert.equal(second.status, 413);
  assert.equal(second.body.message, "用户存储配额已用尽");
});

test("P1-4：同一用户更换 file_id 仍受分片数配额限制", async () => {
  const first = await uploadChunk("quota-b", "q-b-1", 0, Buffer.alloc(10, 3));
  assert.equal(first.status, 200);

  const second = await uploadChunk("quota-b", "q-b-2", 0, Buffer.alloc(10, 4));
  assert.equal(second.status, 400);
  assert.equal(second.body.message, "用户分片配额已用尽");
});

// T-37：配额 check-then-act 的并发突破。10 个 upload 同时到达时，若
// 「读 usage → 三级校验 → 写盘 → enqueue → flush」没有互斥，每个请求都会
// 读到空的 user usage 并通过校验，MAX_USER_CHUNKS=1 形同虚设。
test("T-37：Promise.all 并发 10 个 upload 不得突破 user 维度配额", async () => {
  const token = "quota-c"; // 全新凭据，DB 中不含该用户的历史分片
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      uploadChunk(token, `q-c-${i}`, 0, Buffer.alloc(16, 0x40 + i))
    )
  );
  // T-73：旧判据 `rejected >= 9` + `okCount <= 1` 允许「10 个全拒绝」也全绿，
  // 无法区分「恰好 1 个通过」与「配额锁把请求全杀掉」。改为精确计数 + 精确原因。
  // 并发胜者不固定，先按状态码排序再比对，顺序无关但取值唯一。
  assert.deepEqual(
    results.map((r) => r.status).sort((a, b) => a - b),
    [200, 400, 400, 400, 400, 400, 400, 400, 400, 400],
    "并发 10 路必须恰好 1 个 200 + 9 个 400"
  );
  const successes = results.filter((r) => r.status === 200);
  const rejections = results.filter((r) => r.status === 400);
  assert.equal(successes.length, 1, "恰好 1 路通过配额校验");
  assert.equal(successes[0].body.code, 200);
  assert.deepEqual(
    rejections.map((r) => r.body.message),
    Array(9).fill("用户分片配额已用尽"),
    "9 个拒绝都必须精确命中 user 维度分片数上限"
  );
});

// T-73：配额中途耗尽。让 A 请求停在「已通过校验、正在落库」的临界区内，
// 此时 B 请求到达并阻塞在同一把 upload-quota 锁上；A 提交后 B 必须看到
// 已被打满的 user usage，被精确拒绝（而不是各自读到空 usage 双双放行）。
test("T-73：配额中途耗尽——后到请求在锁释放后以精确 400 拒绝", async () => {
  const { FileChunk } = require("../src/models");
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
    // supertest 惰性发起，.then 才会真正发请求。
    const first = uploadChunk("quota-d", "q-d-1", 0, Buffer.alloc(10, 5)).then(
      (r) => r
    );
    await firstFlushReached;
    const second = uploadChunk("quota-d", "q-d-2", 0, Buffer.alloc(10, 6)).then(
      (r) => r
    );
    releaseFirst();
    const [firstRes, secondRes] = await Promise.all([first, second]);

    assert.equal(firstRes.status, 200, "先到的请求应成功落盘");
    assert.equal(firstRes.body.code, 200);
    assert.equal(secondRes.status, 400, "后到的请求必须撞上已耗尽的配额");
    assert.equal(secondRes.body.message, "用户分片配额已用尽");
    assert.equal(calls, 1, "被拒绝的请求不得再触发落库");
  } finally {
    FileChunk.bulkCreate = originalBulkCreate;
  }
});
