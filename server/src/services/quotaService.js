// VU-54：从 uploadController 抽离的「分片配额聚合」服务，也是 VU-03/04/11 的落地位置。
// 配额以 DB 聚合（FileChunk.size / count）作为唯一 source of truth，
// 彻底消除原进程内 Map 的「重启丢失 + 并发首访绕过」（VU-03），
// 以及每次失效后全目录 stat 扫描的 O(n) 开销（VU-11）。

const { FileChunk, sequelize } = require("../models");
const { withSqliteBusyRetry } = require("../utils/sqliteRetry");

const aggregateChunkUsage = async (extraWhere = {}) => {
  // 注意：findAll 返回 Model 实例数组，不是 [rows, metadata] 元组，
  // 不可写成 const [rows] = ...（会解构成首个实例而非数组）。
  const rows = await withSqliteBusyRetry(() =>
    FileChunk.findAll({
      where: { status: 1, ...extraWhere },
      attributes: [
        [sequelize.fn("SUM", sequelize.col("size")), "bytes"],
        [sequelize.fn("COUNT", sequelize.col("*")), "count"],
      ],
    })
  );
  const row = rows && rows[0] ? rows[0].get({ plain: true }) : {};
  return {
    bytes: Number(row.bytes) || 0,
    count: Number(row.count) || 0,
  };
};

const getChunkUsage = (storageId) => aggregateChunkUsage({ file_id: storageId });
const getGlobalChunkUsage = () => aggregateChunkUsage({});
const getUserChunkUsage = (userId) => aggregateChunkUsage({ user_id: userId });

module.exports = {
  aggregateChunkUsage,
  getChunkUsage,
  getGlobalChunkUsage,
  getUserChunkUsage,
};
