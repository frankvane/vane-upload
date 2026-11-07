const { sequelize } = require("../config/database");
const defineFile = require("./file");
const defineFileChunk = require("./fileChunk");

const File = defineFile(sequelize);
const FileChunk = defineFileChunk(sequelize);

File.hasMany(FileChunk, {
  foreignKey: "file_id",
  sourceKey: "file_id",
  constraints: false,
});

FileChunk.belongsTo(File, {
  foreignKey: "file_id",
  targetKey: "file_id",
  constraints: false,
});

const syncModels = async (options = {}) => {
  await sequelize.sync(options);
};

module.exports = {
  sequelize,
  File,
  FileChunk,
  syncModels,
};
