/**
 * 合并落盘前的文件类型策略：决定哪些文件可以进入 UPLOADS_DIR。
 *
 * 静态映射 uploads 目录时，`.html` / `.svg` / `.exe` 等内容会变成存储型 XSS
 * 或恶意文件分发面，因此不能信任客户端给的扩展名或内容探测结果。
 *
 * 策略：
 *  1) 危险扩展名一律拒绝（即使内容是合法 PNG，也挡住「PNG 内容 + .html 文件名」）；
 *  2) 危险 MIME 一律拒绝；
 *  3) 可选 ALLOWED_MIME_TYPES 白名单：配置后只放行白名单，探测不出类型的也拒绝
 *     （纯文本等需在白名单场景显式声明）。
 *
 * 校验发生在 staging 阶段、moveIntoPlace 之前，415 时 uploads 目录零残留。
 */
const fs = require("fs");
const path = require("path");
const { config } = require("../config");

// E2E-R2：与前端共用同一份清单（src/shared/fileSafety.ts 读取同一文件），
// 避免前端放行、后端 415 的双口径问题。
const dangerousFileTypes = require("../config/dangerous-file-types.json");

const DANGEROUS_EXTENSIONS = new Set(dangerousFileTypes.extensions);
const DANGEROUS_MIMES = new Set(dangerousFileTypes.mimes);

// T-39：file-type 无法识别纯文本，HTML / SVG / 脚本这类存储型 XSS 载体在
// mime=null 时会绕过「危险 MIME」校验。未配白名单时对文件头做基础嗅探，
// 命中这些明确标记即拒绝；正常纯文本 / 二进制不含它们。
const MARKUP_SNIFF_BYTES = 4096;
const DANGEROUS_MARKUP =
  /<\s*(?:html|script|svg|iframe|object|embed|!doctype|\?php|%)/i;

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

// 只读文件头，避免为大文件做全量读；读取失败按「无可嗅探内容」处理，不阻断上传。
const readHeadText = async (filePath) => {
  let handle;
  try {
    handle = await fs.promises.open(filePath, "r");
    const buffer = Buffer.alloc(MARKUP_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MARKUP_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
};

// 二进制（含 NUL 或大量控制字符）不参与标记嗅探，避免误伤正常二进制上传。
const looksLikeText = (head) => {
  if (!head || head.includes("\0")) return false;
  let control = 0;
  for (let i = 0; i < head.length; i += 1) {
    const code = head.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) control += 1;
  }
  return control / head.length < 0.05;
};

/**
 * @returns {Promise<{mime: string|null, ext: string}>} 供落库使用的类型信息
 * @throws 415 当类型/扩展名不被允许
 */
const assertSafeFileType = async ({ filePath, fileName }) => {
  const detected = await detectFileType(filePath);
  const mime = detected?.mime || null;
  const nameString = String(fileName || "");
  const fromName = path.extname(nameString).replace(".", "").toLowerCase();
  const ext = detected?.ext || fromName;

  // T-39 ①：path.extname 只看末段，`payload.html.png` 的末段是 png，
  // 但中间的 html 仍是危险类型。逐段过危险清单，堵住双扩展名绕过。
  for (const segment of nameString.split(".")) {
    const normalized = segment.toLowerCase();
    if (DANGEROUS_EXTENSIONS.has(normalized)) {
      throw httpError(415, `不允许上传 .${normalized} 类型的文件`, {
        extension: normalized,
        reason: "dangerous-extension",
      });
    }
  }

  // T-39 ②：落盘用的 ext 可能来自内容探测（detected.ext）而非文件名，
  // 必须再过一次危险清单，防止以危险后缀落盘。
  const normalizedExt = String(ext || "").toLowerCase();
  if (DANGEROUS_EXTENSIONS.has(normalizedExt)) {
    throw httpError(415, `不允许上传 .${normalizedExt} 类型的文件`, {
      extension: normalizedExt,
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
  } else if (mime === null) {
    // T-39 ③：未配白名单且探测不出类型时，旧逻辑对 HTML / SVG / 脚本这类
    // 纯文本载体直接放行。仅当文件头看起来是文本时做标记嗅探，命中即 415。
    const head = await readHeadText(filePath);
    if (looksLikeText(head) && DANGEROUS_MARKUP.test(head)) {
      throw httpError(415, "文件内容包含不允许的标记", {
        reason: "dangerous-markup",
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
