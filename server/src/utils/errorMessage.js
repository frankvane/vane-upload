/**
 * P2-10：控制器 catch 分支的统一错误文案脱敏。
 *
 * 此前 uploadController 有 6 处直接
 * `jsonError(res, 500, error.message)`，绕过 app.js 的 errorHandler，
 * 把 SQL 片段、绝对路径等内部细节回传客户端。
 */
const { config } = require("../config");

/**
 * 决定返回给客户端的错误文案。
 * @param {unknown} error 捕获到的异常
 * @param {string} [fallback] 非安全环境下使用的通用文案
 */
const redactErrorMessage = (error, fallback = "服务器内部错误，请稍后重试") => {
  // VU-55：环境判定统一走 config，不再各自读 NODE_ENV。
  // T-75：仅 test 保留原始 message；development 也属真实暴露面，与 app.js
  // errorHandler 口径一致，5xx 不得泄漏 SQL 片段 / 绝对路径。
  if (config.isTest()) {
    const message = error && error.message;
    return typeof message === "string" && message ? message : fallback;
  }
  return fallback;
};

module.exports = { redactErrorMessage };
