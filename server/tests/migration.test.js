// VU-12 / VU-53：迁移机制。
// 验证 `migrateDatabase()` 能在「已存在但缺少新索引」的存量库上幂等补建复合索引，
// 且可重复执行无副作用（不依赖 sequelize.sync({force}) 重建表）。
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rui-migrate-"));
process.env.NODE_ENV = "test";
process.env.DB_STORAGE = path.join(testRoot, "db.sqlite");
process.env.SERVER_TMP_UPLOAD_DIR = path.join(testRoot, "tmp");
process.env.SERVER_UPLOADS_DIR = path.join(testRoot, "uploads");

const { sequelize, syncModels, migrateDatabase } = require("../src/models");

const listIndexes = async (table) => {
  const [rows] = await sequelize.query(`PRAGMA index_list('${table}')`);
  return rows.map((row) => row.name);
};

test.before(async () => {
  await syncModels({ force: true });
});

test.after(async () => {
  await sequelize.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("VU-12：migrateDatabase 在存量库上补建缺失的复合索引", async () => {
  // 模拟「已存在但缺新索引」的存量库：删掉一个由模型定义的索引
  await sequelize.query('DROP INDEX IF EXISTS "idx_chunks_file_status_index"');
  let indexes = await listIndexes("file_chunks");
  assert.ok(!indexes.includes("idx_chunks_file_status_index"), "前置：索引应被删除");

  await migrateDatabase();

  indexes = await listIndexes("file_chunks");
  assert.ok(
    indexes.includes("idx_chunks_file_status_index"),
    "缺失的复合索引必须被补齐"
  );
  // 其余模型定义的索引也应全部存在
  assert.ok(indexes.includes("idx_chunks_user_status"));
  assert.ok(indexes.includes("idx_chunks_file_id"));
  const fileIndexes = await listIndexes("files");
  assert.ok(fileIndexes.includes("idx_files_user_md5_size_status"));
});

test("VU-12：migrateDatabase 幂等，可重复执行不报错", async () => {
  await migrateDatabase();
  await migrateDatabase();
  const indexes = await listIndexes("file_chunks");
  const count = indexes.filter(
    (name) => name === "idx_chunks_file_status_index"
  ).length;
  assert.equal(count, 1, "索引不应被重复创建");
});
