// P1-4：user 维度分片配额——同一凭据更换 file_id 仍受限。
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "secure";
process.env.FILE_AUTH_TOKEN = "quota-a,quota-b,quota-c";
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
  const okCount = results.filter((r) => r.status === 200).length;
  const rejected = results.filter(
    (r) => r.status === 413 || r.status === 400
  ).length;
  assert.ok(
    rejected >= 9,
    `并发突破配额：期望至少 9 个 413/400，实际 rejected=${rejected}, ok=${okCount}, statuses=[${results
      .map((r) => r.status)
      .join(",")}]`
  );
  assert.ok(
    okCount <= 1,
    `成功落盘的请求不得超过 MAX_USER_CHUNKS=1，实际 ${okCount}`
  );
});
