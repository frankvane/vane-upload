// VU-63 E2E 冒烟（后端集成）：启动 app 并走完整分片生命周期。
// 覆盖：秒传预检 → 多分片上传 → 合并 → 再次秒传命中。
//
// 说明：完整浏览器级 E2E（选文件 / 暂停恢复 / 取消 / 刷新续传 / 产物 md5 一致性）
// 需独立 e2e 框架（如 Playwright），当前沙箱无外网无法安装；此处交付可离线运行的
// 后端集成冒烟，验证服务端全链路正确性，并为后续接入 Playwright 提供冒烟基线。
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

process.env.NODE_ENV = "test";
// VU-61：全部落到 OS 临时目录，仓库内零新增文件。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rui-smoke-"));
process.env.SERVER_TMP_UPLOAD_DIR = path.join(tmpRoot, "tmp");
process.env.SERVER_UPLOADS_DIR = path.join(tmpRoot, "uploads");
const testDbStorage = path.join(tmpRoot, "smoke.sqlite");
process.env.DB_STORAGE = testDbStorage;
process.env.AUTH_MODE = "demo";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";

const app = require("../src/app");
const { syncModels, sequelize } = require("../src/models");
const { md5Buffer } = require("../src/utils/hash");

const splitContent = (content, parts) => {
  const size = Math.ceil(content.length / parts);
  return Array.from({ length: parts }, (_, i) =>
    content.slice(i * size, (i + 1) * size)
  );
};

test.before(async () => {
  await syncModels({ force: true });
});

test.after(async () => {
  await sequelize.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("E2E 冒烟：秒传预检 → 3 分片上传 → 合并 → 再次秒传命中", async () => {
  const fileId = "smoke-full-1";
  const fileName = "smoke.txt";
  const content = "alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel";
  const chunks = splitContent(content, 3);
  const fullMd5 = md5Buffer(Buffer.from(content, "utf8"));

  // 1) 秒传预检：内容从未上传 → uploaded:false
  const instantRes = await request(app)
    .post("/api/file/instant")
    .send({ file_id: fileId, md5: fullMd5, size: content.length, name: fileName });
  assert.equal(instantRes.status, 200);
  assert.equal(instantRes.body.code, 200);
  assert.equal(instantRes.body.data.uploaded, false);

  // 2) 逐分片上传
  for (let i = 0; i < chunks.length; i++) {
    const buf = Buffer.from(chunks[i], "utf8");
    const res = await request(app)
      .post("/api/file/upload")
      .field("file_id", fileId)
      .field("index", String(i))
      .field("chunk_md5", md5Buffer(buf))
      .attach("chunk", buf, { filename: `${fileId}.bin` });
    assert.equal(res.status, 200, `分片 ${i} 上传应成功`);
    assert.equal(res.body.code, 200);
  }

  // 3) 合并
  const mergeRes = await request(app).post("/api/file/merge").send({
    file_id: fileId,
    md5: fullMd5,
    name: fileName,
    size: content.length,
    total: chunks.length,
  });
  assert.equal(mergeRes.status, 200);
  assert.equal(mergeRes.body.code, 200);

  // 4) 再次秒传预检：内容已合并 → 命中 uploaded:true（验证全链路服务端正确）
  const instantAgain = await request(app)
    .post("/api/file/instant")
    .send({ file_id: fileId, md5: fullMd5, size: content.length, name: fileName });
  assert.equal(instantAgain.status, 200);
  assert.equal(instantAgain.body.code, 200);
  assert.equal(instantAgain.body.data.uploaded, true);
});

test("E2E 冒烟：不同内容 + 不同 file_id 互不串（租户/内容隔离）", async () => {
  const contentA = "payload-A-payload-A-payload-A";
  const contentB = "payload-B-different-content-here";
  const chunksA = splitContent(contentA, 2);
  const chunksB = splitContent(contentB, 2);
  const md5A = md5Buffer(Buffer.from(contentA, "utf8"));
  const md5B = md5Buffer(Buffer.from(contentB, "utf8"));

  for (const [fileId, chunks, md5] of [
    ["smoke-A", chunksA, md5A],
    ["smoke-B", chunksB, md5B],
  ]) {
    for (let i = 0; i < chunks.length; i++) {
      const buf = Buffer.from(chunks[i], "utf8");
      const res = await request(app)
        .post("/api/file/upload")
        .field("file_id", fileId)
        .field("index", String(i))
        .field("chunk_md5", md5Buffer(buf))
        .attach("chunk", buf, { filename: `${fileId}.bin` });
      assert.equal(res.status, 200);
      assert.equal(res.body.code, 200);
    }
    const mergeRes = await request(app)
      .post("/api/file/merge")
      .send({
        file_id: fileId,
        md5,
        name: `${fileId}.txt`,
        size: (fileId === "smoke-A" ? contentA : contentB).length,
        total: chunks.length,
      });
    assert.equal(mergeRes.status, 200);
    assert.equal(mergeRes.body.code, 200);
  }

  // A 命中、B 命中；A 的内容不应被 B 的内容污染
  const aInstant = await request(app)
    .post("/api/file/instant")
    .send({ file_id: "smoke-A", md5: md5A, size: contentA.length, name: "smoke-A.txt" });
  assert.equal(aInstant.body.data.uploaded, true);
  const bInstant = await request(app)
    .post("/api/file/instant")
    .send({ file_id: "smoke-B", md5: md5B, size: contentB.length, name: "smoke-B.txt" });
  assert.equal(bInstant.body.data.uploaded, true);
});
