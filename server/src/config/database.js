const path = require("path");
const { Sequelize } = require("sequelize");
const { DATA_DIR, ensureDir } = require("./paths");
const { config } = require("./index");
const sqlite3Adapter = require("../utils/sqlite3Adapter");

const dbStorage =
  config.dbStorage() || path.join(DATA_DIR, "indexeddb-upload.sqlite");

if (dbStorage !== ":memory:") {
  ensureDir(path.dirname(dbStorage));
}

const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: dbStorage,
  dialectModule: sqlite3Adapter,
  logging: config.sqlLog() ? console.log : false,
  pool: {
    // SQLite 写锁粒度较粗，限制单连接可显著降低 "database is locked"
    max: 1,
    min: 1,
    idle: 10000,
  },
  retry: {
    match: [/SQLITE_BUSY/i, /database is locked/i],
    max: 5,
  },
});

module.exports = {
  sequelize,
  dbStorage,
};
