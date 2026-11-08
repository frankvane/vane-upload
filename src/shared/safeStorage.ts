/**
 * 安全本地存储封装（F1）：
 *  - 所有 localStorage 访问包裹 try/catch：隐私模式 / 配额超限 / 解析失败 / 损坏数据
 *    均不抛出，一律返回 fallback，避免污染数据或不可用存储导致 store 初始化崩溃。
 *  - key 统一加 `rui:` 命名空间，避免与其它库或多实例互相覆盖。
 *  - 向前兼容：读取时若 `rui:` 前缀 key 不存在，回退读取无前缀旧 key（一次性迁移读取），
 *    后续写入只写 `rui:` 前缀，旧 key 自然淘汰（不主动删除以免干扰其它消费者）。
 *  - 轻量 schema 校验：解析结果的基础类型与 fallback 不一致时视为损坏，返回 fallback。
 *
 * 仅用于浏览器侧偏好/轻量持久化；SSR（localStorage 未定义）安全降级为只读 fallback。
 */

const PREFIX = "rui:";

/**
 * VU-48：可用性探测是同步写，旧实现每次 get/set/remove 都重复一次
 * （initSettings 连读 4 个 key 就是 4 次探测写）。结果模块级惰性缓存：
 * 成功缓存 store 引用，失败永久降级，避免反复触碰被禁用的存储。
 * undefined = 尚未探测，null = 已确认不可用。
 */
let cachedStorage: Storage | null | undefined;

/**
 * 仅供测试：清空惰性缓存，模拟「模块首次加载」以验证探测只执行一次。
 * 生产代码不应调用；未加入 src/index.ts 的公共导出。
 */
export const resetSafeStorageCacheForTests = (): void => {
  cachedStorage = undefined;
};

function getStorage(): Storage | null {
  if (cachedStorage !== undefined) return cachedStorage;
  try {
    if (typeof localStorage === "undefined" || localStorage === null) {
      cachedStorage = null;
      return cachedStorage;
    }
    // 探测可用性：隐私模式/禁用时会抛错
    const probe = `${PREFIX}__probe__`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    cachedStorage = localStorage;
  } catch {
    cachedStorage = null;
  }
  return cachedStorage;
}

export const safeStorage = {
  getItem<T>(key: string, fallback: T): T {
    const store = getStorage();
    if (store === null) {
      return fallback;
    }
    try {
      const raw = store.getItem(PREFIX + key) ?? store.getItem(key);
      if (raw === null) {
        return fallback;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // 兼容旧版裸写：早期版本把网络显示模式等偏好以原生字符串直接写入
        // （未 JSON 编码），此处回退为原始字符串，避免升级后静默丢失偏好。
        parsed = raw;
      }
      // 轻量 schema 校验：类型与 fallback 不一致视为损坏
      if (fallback !== null && typeof parsed !== typeof fallback) {
        return fallback;
      }
      return parsed as T;
    } catch {
      return fallback;
    }
  },

  setItem(key: string, value: unknown): void {
    const store = getStorage();
    if (store === null) {
      return;
    }
    try {
      store.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // 配额超限 / 隐私模式：静默忽略，不阻断主流程
    }
  },

  removeItem(key: string): void {
    const store = getStorage();
    if (store === null) {
      return;
    }
    try {
      store.removeItem(PREFIX + key);
      store.removeItem(key);
    } catch {
      // 同上
    }
  },
};
