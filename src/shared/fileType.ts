/**
 * VU-37：文件类型白名单匹配。
 *
 * 旧实现是 `mimeType.includes(type.toLowerCase())`：
 *  - 允许 "image/png" 时会误放行 "image/png-fake"（子串命中）；
 *  - "image/*" 这类通配写法永远匹配不上；
 *  - 每个文件 × 每个允许类型都重复 toLowerCase / startsWith / slice。
 *
 * 这里把白名单一次编译成三组结构，循环内只做 O(1) 集合查询或前缀判断。
 * 纯函数、无 React 依赖，便于独立单测。
 */

export interface AllowedTypeMatcher {
  /** 以 "." 开头的扩展名（不含点，已 lowercase） */
  extensions: Set<string>;
  /** 精确 MIME 类型 */
  exact: Set<string>;
  /** 形如 "image/*" 的前缀，编译为 "image/" */
  wildcardPrefixes: string[];
}

export const compileAllowedTypes = (
  types: readonly string[],
): AllowedTypeMatcher => {
  const extensions = new Set<string>();
  const exact = new Set<string>();
  const wildcardPrefixes: string[] = [];
  for (const raw of types) {
    const type = raw.trim().toLowerCase();
    if (!type) continue;
    if (type.startsWith(".")) {
      extensions.add(type.slice(1));
    } else if (type.endsWith("/*")) {
      wildcardPrefixes.push(type.slice(0, -1)); // "image/*" -> "image/"
    } else {
      exact.add(type);
    }
  }
  return { extensions, exact, wildcardPrefixes };
};

/** 空白名单表示不限制（与调用方 `length > 0` 的旧语义一致）。 */
export const isFileTypeAllowed = (
  file: { name: string; type: string },
  matcher: AllowedTypeMatcher,
): boolean => {
  if (
    matcher.extensions.size === 0 &&
    matcher.exact.size === 0 &&
    matcher.wildcardPrefixes.length === 0
  ) {
    return true;
  }
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = file.type.toLowerCase();
  return (
    matcher.extensions.has(extension) ||
    matcher.exact.has(mimeType) ||
    matcher.wildcardPrefixes.some((prefix) => mimeType.startsWith(prefix))
  );
};
