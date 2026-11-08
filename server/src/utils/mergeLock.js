/**
 * VU-08：同键合并锁注册表。
 *
 * 旧实现直接 `await inFlight.promise`，既没有等待超时也没有等待者上限：
 * 一个卡住的合并会让所有同键请求永久挂起，异常客户端还能无界堆积等待者。
 * 抽成独立模块后可以对这两个边界做确定性单测，也让控制器少一段基础设施代码。
 */
const httpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const withTimeout = (promise, timeoutMs, message) =>
  new Promise((resolve, reject) => {
    // 这里不能 unref：等待锁的是「在途请求」，计时器必须保持进程存活，
    // 否则超时永远不触发（事件循环会先退出），请求永久挂起。
    const timer = setTimeout(() => reject(httpError(503, message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

/**
 * @param {{waitTimeoutMs?: () => number, maxWaiters?: () => number}} options
 *  取值用函数传入，保证运行时调整环境变量仍能生效（与 config 的语义一致）。
 */
const createMergeLockRegistry = (options = {}) => {
  const waitTimeoutMs = options.waitTimeoutMs || (() => 30000);
  const maxWaiters = options.maxWaiters || (() => 64);
  const locks = new Map();

  /** 有同键合并在飞行时返回 true（已等到释放）；没有则返回 false。 */
  const wait = async (key) => {
    const entry = locks.get(key);
    if (!entry) return false;
    if (entry.waiters >= maxWaiters()) {
      throw httpError(429, "too many concurrent merges for this file");
    }
    entry.waiters += 1;
    try {
      await withTimeout(
        entry.promise,
        waitTimeoutMs(),
        "merge lock wait timeout, please retry later"
      );
    } finally {
      entry.waiters -= 1;
    }
    return true;
  };

  /** 占位并返回 release 函数；调用方必须在 finally 中释放。 */
  const acquire = (key) => {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    locks.set(key, { promise, release, waiters: 0 });
    return () => {
      const current = locks.get(key);
      if (current) {
        locks.delete(key);
        current.release();
      }
    };
  };

  return {
    wait,
    acquire,
    size: () => locks.size,
    waiters: (key) => locks.get(key)?.waiters ?? 0,
    keys: () => Array.from(locks.keys()),
  };
};

module.exports = { createMergeLockRegistry };
