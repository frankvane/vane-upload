const { DataTypes } = require("sequelize");

module.exports = (sequelize) =>
  sequelize.define(
    "FileChunk",
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      file_id: {
        type: DataTypes.STRING(128),
        allowNull: false,
      },
      chunk_index: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      status: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      user_id: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: "test",
      },
      upload_time: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      chunk_md5: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      // VU-03/04/11：分片字节数此前只存在于磁盘（stat.size），导致配额只能靠
      // 进程内近似计数（重启/并发可绕过，VU-03）或全目录 stat 扫描（VU-11）。
      // 持久化 size 后，配额可直接用 DB 聚合（SUM/COUNT）作为 source of truth。
      size: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: "file_chunks",
      underscored: true,
      // VU-53：高频查询 `WHERE file_id=? AND status=1 AND user_id=?`、
      // 按用户播种用量 `WHERE user_id=? AND status=1` 都需要复合索引；
      // 同时给 `findAll` 一个可由索引支撑的有序范围。
      indexes: [
        { fields: ["file_id"] },
        { fields: ["file_id", "status", "chunk_index"] },
        { fields: ["user_id", "status"] },
        { fields: ["status"] },
        { unique: true, fields: ["file_id", "chunk_index"] },
      ],
    }
  );
