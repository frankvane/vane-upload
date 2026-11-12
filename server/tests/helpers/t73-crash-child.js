/**
 * T-73 真实崩溃恢复的子进程夹具（CommonJS，由 t73-crash-recovery.test.js 派生）。
 *
 * 两个阶段的**不同进程**共享同一份 SQLite 库与上传目录：
 *  - seed：建表 → 上传前 2 片 → 打印 SEED_READY → 保持进程存活，等父进程 SIGKILL；
 *  - recover：全新进程、绝不 syncModels({force:true})，只读崩溃前留下的 DB/磁盘，
 *    查询 /status 后补传剩余分片并合并，把观测结果以 RESULT JSON 打印给父进程。
 *
 * 不使用 supertest 之外的任何新依赖；环境隔离依赖父进程注入的 T73_* 绝对路径。
 */
"use strict";

const fs = require("fs");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "demo";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.DB_STORAGE = process.env.T73_DB_STORAGE;
process.env.SERVER_TMP_UPLOAD_DIR = process.env.T73_TMP_UPLOAD_DIR;
process.env.SERVER_UPLOADS_DIR = process.env.T73_UPLOADS_DIR;
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";

const app = require("../../src/app");
const request = require("supertest");
const { syncModels, sequelize, File } = require("../../src/models");
const { UPLOADS_DIR } = require("../../src/config/paths");
const { md5Buffer } = require("../../src/utils/hash");

const FILE_ID = "t73_crash_file";
const PARTS = ["alpha", "bravo", "charlie", "delta"];
const NAME = "t73-crash.bin";
const MERGED = Buffer.from(PARTS.join(""), "utf8");
const MERGED_MD5 = md5Buffer(MERGED);

const upload = (index) =>
  request(app)
    .post("/api/file/upload")
    .field("file_id", FILE_ID)
    .field("index", String(index))
    .attach("chunk", Buffer.from(PARTS[index], "utf8"), {
      filename: `c${index}.bin`,
    });

const run = async () => {
  if (process.env.T73_PHASE === "seed") {
    await syncModels({ force: true });
    const statuses = [];
    for (let i = 0; i < 2; i += 1) {
      const res = await upload(i);
      statuses.push(res.status);
      if (res.status !== 200) {
        throw new Error(`seed 上传第 ${i} 片失败：${res.status}`);
      }
    }
    // 关键：不 close DB、不 flush 定时器、不打印最终结果。
    // 父进程收到 SEED_READY 后立刻 SIGKILL，模拟上传中途进程被强制杀死。
    process.stdout.write(`SEED_READY ${JSON.stringify({ statuses })}\n`);
    setInterval(() => {}, 1000);
    return;
  }

  // recover：全新进程。只读既有 DB，绝不重置表——这正是「崩溃恢复」与
  // TC-24 旧实现（同进程重新查一次 /status）的本质区别。
  const statusRes = await request(app)
    .get("/api/file/status")
    .query({ file_id: FILE_ID, md5: "unused" });
  const resumed = statusRes.body?.data?.chunks;

  const uploadStatuses = [];
  for (let i = 2; i < PARTS.length; i += 1) {
    const res = await upload(i);
    uploadStatuses.push(res.status);
  }

  const mergeRes = await request(app).post("/api/file/merge").send({
    file_id: FILE_ID,
    md5: MERGED_MD5,
    name: NAME,
    size: MERGED.length,
    total: PARTS.length,
  });

  const rows = await File.findAll({ where: { md5: MERGED_MD5, status: 1 } });
  const artifactMd5 = rows.length
    ? md5Buffer(
        fs.readFileSync(
          path.join(UPLOADS_DIR, path.basename(rows[0].file_path)),
        ),
      )
    : null;

  process.stdout.write(
    `RESULT ${JSON.stringify({
      statusCode: statusRes.status,
      resumed,
      uploadStatuses,
      mergeStatus: mergeRes.status,
      mergeCode: mergeRes.body?.code,
      rowCount: rows.length,
      artifactMd5,
      expectedMd5: MERGED_MD5,
      artifactBytes: MERGED.length,
    })}\n`,
  );
  await sequelize.close();
};

run().catch((error) => {
  process.stderr.write(`CHILD_ERROR ${String(error.stack || error)}\n`);
  process.exitCode = 1;
});
