const { DataTypes } = require("sequelize");

module.exports = (sequelize) =>
  sequelize.define(
    "File",
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      file_id: {
        type: DataTypes.STRING(128),
        allowNull: false,
        unique: true,
      },
      file_name: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      size: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      user_id: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: "test",
      },
      status: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      md5: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      category_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      file_ext: {
        type: DataTypes.STRING(32),
        allowNull: true,
      },
      file_type: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      file_path: {
        type: DataTypes.STRING(512),
        allowNull: true,
      },
      thumbnail_path: {
        type: DataTypes.STRING(512),
        allowNull: true,
      },
    },
    {
      tableName: "files",
      underscored: true,
      indexes: [
        { fields: ["file_id"] },
        { fields: ["md5"] },
        { fields: ["status"] },
      ],
    }
  );
