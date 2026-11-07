/**
 * P2-10：控制器 catch 分支的统一错误文案脱敏。
 *
 * 此前 uploadController 有 6 处直接
 * `jsonError(res, 500, error.message)`，绕过 app.js 的 errorHandler，
 * 把 SQL 片段、绝对路径等内部细节回传客户端。
 */

const SAFE_ENVS = new Set(["test", "development"]);

const isSafeEnv = () => SAFE_ENVS.has(process.env.NODE_ENV);

/**
 * 决定返回给客户端的错误文案。
 * @param {unknown} error 捕获到的异常
 * @param {string} [fallback] 非安全环境下使用的通用文案
 */
const redactErrorMessage = (error, fallback = "internal server error") => {
  if (isSafeEnv()) {
    const message = error && error.message;
    return typeof message === "string" && message ? message : fallback;
  }
  return fallback;
};

module.exports = { redactErrorMessage, isSafeEnv };
