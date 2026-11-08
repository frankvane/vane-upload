/**
 * 危险文件类型判定（E2E-R2）。
 *
 * 清单来自 `server/src/config/dangerous-file-types.json`，与服务端合并落盘前的
 * 校验（server/src/utils/filePolicy.js）读取同一份文件，保证前后端口径一致：
 * 前端在选择阶段就给出可读原因，不会「传完所有分片才在 /merge 拿到 415」。
 */
import dangerousFileTypes from "../../server/src/config/dangerous-file-types.json";

const DANGEROUS_EXTENSIONS = new Set<string>(dangerousFileTypes.extensions);
const DANGEROUS_MIMES = new Set<string>(
  dangerousFileTypes.mimes.map((mime) => mime.toLowerCase())
);

export interface DangerousFileViolation {
  /** 命中的维度：扩展名或 MIME */
  kind: "extension" | "mime";
  /** 命中的具体值（扩展名带点，MIME 原样） */
  value: string;
}

/**
 * 取文件扩展名（小写、不含点），与 Node `path.extname` 的口径一致：
 * 无扩展名或以点开头的隐藏文件（如 `.htaccess`）返回空串。
 */
export const getFileExtension = (fileName: string): string => {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === fileName.length - 1) {
    return "";
  }
  return fileName.slice(lastDot + 1).toLowerCase();
};

/** 命中危险扩展名或危险 MIME 时返回违规描述，否则返回 null */
export const findDangerousFileViolation = (file: {
  name: string;
  type?: string;
}): DangerousFileViolation | null => {
  const extension = getFileExtension(file.name);
  if (extension && DANGEROUS_EXTENSIONS.has(extension)) {
    return { kind: "extension", value: `.${extension}` };
  }

  const mime = (file.type ?? "").toLowerCase();
  if (mime && DANGEROUS_MIMES.has(mime)) {
    return { kind: "mime", value: mime };
  }

  return null;
};

/** 生成给用户看的原因文案 */
export const formatDangerousFileReason = (
  violation: DangerousFileViolation
): string => {
  return violation.kind === "extension"
    ? `不允许上传的类型（危险扩展名 ${violation.value}）`
    : `不允许上传的类型（危险内容类型 ${violation.value}）`;
};
