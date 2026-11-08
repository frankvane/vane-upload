// VU-54：从 uploadController 抽离的「合并产物落盘 IO」辅助。
const fs = require("fs");

// P1-2：合并产物先落在 staging 文件，校验通过后再原子移入 UPLOADS_DIR。
// 同卷时 rename 为原子操作；跨卷（SERVER_TMP_UPLOAD_DIR / SERVER_UPLOADS_DIR 分处不同设备）
// 时退化为 copy + unlink，仍然是「先完整再出现」。
const moveIntoPlace = async (from, to) => {
  try {
    await fs.promises.rename(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }
    await fs.promises.copyFile(from, to);
    await fs.promises.unlink(from).catch(() => undefined);
  }
};

module.exports = { moveIntoPlace };
