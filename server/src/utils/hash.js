const crypto = require("crypto");
const fs = require("fs");

/**
 * VU-56：删除 `calculatePartialMd5` / `calculatePartialMd5Async` /
 * `getPartialMd5Mode` / `PARTIAL_MD5_FULL_LIMIT` 等零调用死代码。
 *
 * 原因不只是「没人用」：后端那套采样是「头 10MB + 尾 1MB」，而前端
 * `filePrepareWorker.ts` 是「首 4MB + 3 个中间 4MB + 尾 4MB + size: 文本」，
 * 两套算法互相矛盾且都无人调用；一旦有人按旧注释启用服务端采样比对，
 * 必然把合法文件误判为损坏。采样口径现在只由前端声明的 `hash_mode` 决定。
 */
const md5Buffer = (buffer) =>
  crypto.createHash("md5").update(buffer).digest("hex");

const md5File = async (filePath) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });

module.exports = {
  md5Buffer,
  md5File,
};
