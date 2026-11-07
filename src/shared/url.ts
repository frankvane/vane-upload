/**
 * 拼接 baseURL 与 API 路径。
 *
 * 规则：
 * - 去掉 base 尾部斜杠与 path 前导斜杠后以一个 "/" 连接，永不产生 "//"；
 * - base 为空串时原样返回 path（同源相对路径，兼容旧行为 `${""}${path}`）；
 * - path 为空串时原样返回 base。
 *
 * 示例：
 *   joinUrl("", "/api/file/merge")            -> "/api/file/merge"
 *   joinUrl("https://x.com", "/api/merge")    -> "https://x.com/api/merge"
 *   joinUrl("https://x.com/", "/api/merge")   -> "https://x.com/api/merge"（不再出现 //）
 *   joinUrl("https://x.com/", "api/merge")    -> "https://x.com/api/merge"
 *   joinUrl("https://x.com/base", "/api/x")   -> "https://x.com/base/api/x"
 */
export const joinUrl = (
  base: string | undefined | null,
  path: string | undefined | null
): string => {
  const safeBase = typeof base === "string" ? base.trim() : "";
  const safePath = typeof path === "string" ? path.trim() : "";

  if (!safePath) {
    return safeBase;
  }

  // 空 base：保持 path 原样（与历史行为 `${baseURL}${apiPath}` 一致）
  if (!safeBase) {
    return safePath;
  }

  return `${safeBase.replace(/\/+$/, "")}/${safePath.replace(/^\/+/, "")}`;
};
