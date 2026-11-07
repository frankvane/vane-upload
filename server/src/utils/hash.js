const crypto = require("crypto");
const fs = require("fs");

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

const calculatePartialMd5 = (filePath) => {
  const hash = crypto.createHash("md5");
  const stats = fs.statSync(filePath);
  const fileSize = stats.size;

  if (fileSize < 10 * 1024 * 1024) {
    const buffer = fs.readFileSync(filePath);
    hash.update(buffer);
    return hash.digest("hex");
  }

  const fd = fs.openSync(filePath, "r");
  try {
    const headerBuffer = Buffer.alloc(10 * 1024 * 1024);
    fs.readSync(fd, headerBuffer, 0, 10 * 1024 * 1024, 0);
    hash.update(headerBuffer);

    if (fileSize > 11 * 1024 * 1024) {
      const tailBuffer = Buffer.alloc(1024 * 1024);
      fs.readSync(fd, tailBuffer, 0, 1024 * 1024, fileSize - 1024 * 1024);
      hash.update(tailBuffer);
    }
  } finally {
    fs.closeSync(fd);
  }

  return hash.digest("hex");
};

const readSlice = async (fileHandle, length, position) => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fileHandle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
};

// P2-8：<10MB 时 calculatePartialMd5* 读的是全量字节，此时哈希即全量 md5；
// >=10MB 才是"头 10MB（+尾 1MB）"的采样哈希，客户端不得拿它做全量严格比对。
const PARTIAL_MD5_FULL_LIMIT = 10 * 1024 * 1024;

const getPartialMd5Mode = (fileSize) =>
  fileSize < PARTIAL_MD5_FULL_LIMIT ? "full" : "sample";

const calculatePartialMd5Async = async (filePath, knownFileSize) => {
  const hash = crypto.createHash("md5");
  const fileSize =
    knownFileSize ?? (await fs.promises.stat(filePath)).size;

  if (fileSize < 10 * 1024 * 1024) {
    const buffer = await fs.promises.readFile(filePath);
    hash.update(buffer);
    return hash.digest("hex");
  }

  const fileHandle = await fs.promises.open(filePath, "r");
  try {
    const headerBuffer = await readSlice(fileHandle, 10 * 1024 * 1024, 0);
    hash.update(headerBuffer);

    if (fileSize > 11 * 1024 * 1024) {
      const tailBuffer = await readSlice(
        fileHandle,
        1024 * 1024,
        fileSize - 1024 * 1024
      );
      hash.update(tailBuffer);
    }
  } finally {
    await fileHandle.close();
  }

  return hash.digest("hex");
};

module.exports = {
  md5Buffer,
  md5File,
  calculatePartialMd5,
  calculatePartialMd5Async,
  PARTIAL_MD5_FULL_LIMIT,
  getPartialMd5Mode,
};
