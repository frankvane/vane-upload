/**
 * VU-08：同键合并锁注册表。
 *
 * 合并同一文件（同 storageId）时，用一把按 `userId:storageId` 计价的锁串行化，
 * 避免并发合并竞争同一 staging / 落盘路径、产生重复落盘或相互 clobber。
 * 等待带超时、等待者数量有上限，防止卡住的合并让请求永久挂起或等待者无界堆积。
 * 抽成独立模块后可以对这些边界做确定性单测，也让控制器少一段基础设施代码。
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

  /**
   * 原子地「等待或获取」合并锁。
   *
   * 旧实现把 wait() 与 acquire() 拆成两个方法，控制器先 await wait() 再调 acquire()，
   * 两步之间不是原子的：两个并发请求可能都从 wait() 得到 false，然后都调 acquire()，
   * 后者用 locks.set 无条件覆盖前者，导致锁注册表被破坏、同键合并失去互斥（互相 clobber）。
   *
   * 这里把「查-等」与「查-设」合并到同一个同步步骤：不存在则立刻 set 并返回 release，
   * 存在则原地 waiter+=1 并 await 其 promise；get 与 set 之间没有任何 await 穿插，
   * 因此绝不会有两个请求同时认为自己拿到了锁。
   *
   * @returns {Promise<{waited: boolean, release: (() => void) | null}>}
   *   waited=true  表示此前已有同键合并在飞、本次只是等待其完成，调用方应做已合并检查后尽快返回；
   *   waited=false 表示本次成功获取锁，release 必须在该请求的 finally 中调用以释放。
   */
  const acquireOrWait = async (key) => {
    const existing = locks.get(key);
    if (existing) {
      if (existing.waiters >= maxWaiters()) {
        throw httpError(429, "该文件并发合并过多，请稍后重试");
      }
      existing.waiters += 1;
      try {
        await withTimeout(
          existing.promise,
          waitTimeoutMs(),
          "merge lock wait timeout, please retry later"
        );
      } finally {
        existing.waiters -= 1;
      }
      return { waited: true, release: null };
    }
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    locks.set(key, { promise, release, waiters: 0 });
    return {
      waited: false,
      release: () => {
        const current = locks.get(key);
        if (current) {
          locks.delete(key);
          current.release();
        }
      },
    };
  };

  return {
    acquireOrWait,
    size: () => locks.size,
    waiters: (key) => locks.get(key)?.waiters ?? 0,
    keys: () => Array.from(locks.keys()),
  };
};

module.exports = { createMergeLockRegistry };
