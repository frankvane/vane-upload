// VU-29：请求参数在入口处统一做强类型校验。
// Number.parseInt("1.9") / Number.parseInt("12abc") 会静默截断成合法值，
// Number(size) 遇到字符串又会让 SQLite 的 BIGINT 比较静默不命中。
// 这里只接受「安全整数」或纯数字字符串，越界/非法一律返回 null 由调用方 400。
const parseStrictInt = (value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  let parsed;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    return null;
  }
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
};

module.exports = { parseStrictInt };
