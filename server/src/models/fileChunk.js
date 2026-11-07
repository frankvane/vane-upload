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
    },
    {
      tableName: "file_chunks",
      underscored: true,
      indexes: [
        { fields: ["file_id"] },
        { fields: ["status"] },
        { unique: true, fields: ["file_id", "chunk_index"] },
      ],
    }
  );
