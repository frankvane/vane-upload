const { sequelize } = require("../config/database");
const defineFile = require("./file");
const defineFileChunk = require("./fileChunk");

const File = defineFile(sequelize);
const FileChunk = defineFileChunk(sequelize);

// VU-56：此前声明了 hasMany / belongsTo 但全项目零 `include`，
// 属于误导性死代码（实际查询全部按 file_id / user_id 手工过滤）。删除。

// VU-12 / VU-53：模型里声明的复合索引只在新表创建时由 sync() 生成；
// 对「已经存在、但缺少新索引」的存量库，sync() 不会补建（不传 alter:true 有损风险）。
// 这里用 `CREATE INDEX IF NOT EXISTS` 做幂等迁移，无论全新还是存量库都能补齐索引，
// 且可重复执行、无副作用。索引名与各模型 `indexes` 定义保持一致，避免与 sync 创建的重复。
const INDEX_MIGRATIONS = [
  { table: "files", name: "idx_files_user_md5_size_status", columns: ["user_id", "md5", "size", "status"] },
  { table: "files", name: "idx_files_user_status", columns: ["user_id", "status"] },
  { table: "files", name: "idx_files_md5", columns: ["md5"] },
  { table: "files", name: "idx_files_status", columns: ["status"] },
  { table: "files", name: "idx_files_file_id", columns: ["file_id"] },
  { table: "file_chunks", name: "idx_chunks_file_status_index", columns: ["file_id", "status", "chunk_index"] },
  { table: "file_chunks", name: "idx_chunks_user_status", columns: ["user_id", "status"] },
  { table: "file_chunks", name: "idx_chunks_status", columns: ["status"] },
  { table: "file_chunks", name: "idx_chunks_file_id", columns: ["file_id"] },
  { table: "file_chunks", name: "idx_chunks_file_chunk_unique", columns: ["file_id", "chunk_index"], unique: true },
];

// VU-03/04/11：给 file_chunks 补 size 列。SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，
// 用 PRAGMA table_info 幂等检查列是否已存在，避免存量库重复 ALTER 报错。
const COLUMN_MIGRATIONS = [
  {
    table: "file_chunks",
    column: "size",
    sql: 'ALTER TABLE "file_chunks" ADD COLUMN "size" INTEGER NOT NULL DEFAULT 0',
  },
];

const hasColumn = async (table, column) => {
  const [rows] = await sequelize.query(`PRAGMA table_info("${table}")`);
  return Array.isArray(rows) && rows.some((row) => row.name === column);
};

/**
 * 幂等迁移：补齐模型定义中的复合索引（主要服务存量库）。
 * 在 sync() 之后调用即可；CREATE INDEX IF NOT EXISTS 保证可重复执行。
 */
const migrateDatabase = async () => {
  for (const migration of INDEX_MIGRATIONS) {
    const columnList = migration.columns.map((column) => `"${column}"`).join(", ");
    const unique = migration.unique ? "UNIQUE " : "";
    await sequelize.query(
      `CREATE ${unique}INDEX IF NOT EXISTS "${migration.name}" ON "${migration.table}" (${columnList})`
    );
  }
  for (const migration of COLUMN_MIGRATIONS) {
    if (!(await hasColumn(migration.table, migration.column))) {
      await sequelize.query(migration.sql);
    }
  }
};

const syncModels = async (options = {}) => {
  await sequelize.sync(options);
  await migrateDatabase();
};

module.exports = {
  sequelize,
  File,
  FileChunk,
  syncModels,
  migrateDatabase,
  INDEX_MIGRATIONS,
};
