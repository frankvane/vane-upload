/**
 * VU-33：合并落盘前的文件类型策略。
 *
 * 旧实现用 file-type 探测出真实类型，却只拿它决定「要不要生成缩略图」：
 * 探测失败时还回退到客户端给的扩展名，于是 `evil.html` / `evil.svg` / `evil.exe`
 * 都能落进 UPLOADS_DIR。若部署侧静态映射该目录，就是存储型 XSS / 恶意文件分发面。
 *
 * 策略：
 *  1) 危险扩展名一律拒绝（无论探测结果如何，避免「PNG 内容 + .html 文件名」）；
 *  2) 危险 MIME 一律拒绝；
 *  3) 可选 ALLOWED_MIME_TYPES 白名单（逗号分隔）：配置后只放行白名单，
 *     探测不出类型的文件也拒绝（纯文本等需在白名单场景显式声明）。
 *
 * 校验发生在 staging 阶段、moveIntoPlace 之前，415 时 uploads 目录零残留。
 */
const path = require("path");
const { config } = require("../config");

// E2E-R2：与前端共用同一份清单（src/shared/fileSafety.ts 读取同一文件），
// 避免前端放行、后端 415 的双口径问题。
const dangerousFileTypes = require("../config/dangerous-file-types.json");

const DANGEROUS_EXTENSIONS = new Set(dangerousFileTypes.extensions);
const DANGEROUS_MIMES = new Set(dangerousFileTypes.mimes);

const httpError = (statusCode, message, details = undefined) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
};

const detectFileType = async (filePath) => {
  try {
    const { fileTypeFromFile } = await import("file-type");
    return await fileTypeFromFile(filePath);
  } catch {
    return null;
  }
};

/**
 * @returns {Promise<{mime: string|null, ext: string}>} 供落库使用的类型信息
 * @throws 415 当类型/扩展名不被允许
 */
const assertSafeFileType = async ({ filePath, fileName }) => {
  const detected = await detectFileType(filePath);
  const mime = detected?.mime || null;
  const fromName = path.extname(String(fileName || "")).replace(".", "").toLowerCase();
  const ext = detected?.ext || fromName;

  if (DANGEROUS_EXTENSIONS.has(fromName)) {
    throw httpError(415, `不允许上传 .${fromName} 类型的文件`, {
      extension: fromName,
      reason: "dangerous-extension",
    });
  }
  if (mime && DANGEROUS_MIMES.has(mime)) {
    throw httpError(415, `不允许上传 ${mime} 类型的文件`, {
      mime,
      reason: "dangerous-mime",
    });
  }

  const allowed = config.allowedMimeTypes();
  if (allowed.length > 0) {
    if (!mime || !allowed.includes(mime.toLowerCase())) {
      throw httpError(415, "文件类型不在允许的白名单内", {
        mime,
        reason: "mime-not-allowlisted",
      });
    }
  }

  return { mime, ext };
};

module.exports = {
  assertSafeFileType,
  detectFileType,
  DANGEROUS_EXTENSIONS,
  DANGEROUS_MIMES,
};
