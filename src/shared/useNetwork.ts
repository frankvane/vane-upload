import { useSyncExternalStore } from "react";

/**
 * 网络状态快照。
 * 对齐 ahooks `useNetwork` 中实际被本项目使用的字段（online/rtt/type/effectiveType），
 * 不引入 `since`/`saveData` 等未被消费的字段（YAGNI）。
 */
export interface NetworkState {
  online: boolean | undefined;
  rtt: number | undefined;
  type: string | undefined;
  effectiveType: string | undefined;
}

/** `navigator.connection`（Network Information API，各浏览器前缀不一） */
interface NetworkInformation extends EventTarget {
  rtt?: number;
  type?: string;
  saveData?: boolean;
  downlink?: number;
  downlinkMax?: number;
  effectiveType?: string;
}

type NavigatorWithConnection = Navigator & {
  connection?: NetworkInformation;
  mozConnection?: NetworkInformation;
  webkitConnection?: NetworkInformation;
};

function getConnection(): NetworkInformation | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  const nav = navigator as NavigatorWithConnection;
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null;
}

function readConnection(): Pick<
  NetworkState,
  "rtt" | "type" | "effectiveType"
> {
  const connection = getConnection();
  if (!connection) {
    return { rtt: undefined, type: undefined, effectiveType: undefined };
  }
  return {
    rtt: connection.rtt,
    type: connection.type,
    effectiveType: connection.effectiveType,
  };
}

const readSnapshot = (): NetworkState => ({
  online: typeof navigator === "undefined" ? undefined : navigator.onLine,
  ...readConnection(),
});

const SERVER_SNAPSHOT: NetworkState = {
  online: undefined,
  rtt: undefined,
  type: undefined,
  effectiveType: undefined,
};

/**
 * VU-44：模块级单例订阅。
 *
 * 旧实现每个 `<FileUpload>` 实例都在 `useEffect` 里各注册一套 online/offline/change，
 * N 个实例 = N 套监听 + N 次 setState 广播。改为 ref-count 订阅：
 * 第一个订阅者注册一次事件源，最后一个订阅者卸载时注销，状态变更广播给所有监听器。
 * 用 `useSyncExternalStore` 而非 `useState + useEffect`，天然避免「卸载后事件仍更新
 * 已卸载组件」与并发渲染下的快照撕裂。
 */
let snapshot: NetworkState = readSnapshot();
const listeners = new Set<() => void>();
let detachEvents: (() => void) | null = null;

const sameSnapshot = (a: NetworkState, b: NetworkState): boolean =>
  a.online === b.online &&
  a.rtt === b.rtt &&
  a.type === b.type &&
  a.effectiveType === b.effectiveType;

const notify = () => {
  for (const listener of listeners) {
    listener();
  }
};

const updateOnline = (online: boolean) => {
  if (snapshot.online === online) {
    return;
  }
  snapshot = { ...snapshot, online };
  notify();
};

const onConnectionChange = () => {
  const next = { ...snapshot, ...readConnection() };
  if (!sameSnapshot(snapshot, next)) {
    snapshot = next;
    notify();
  }
};

const attachEvents = () => {
  if (detachEvents !== null || typeof window === "undefined") {
    return;
  }

  // 冷启动（从 0 个订阅者恢复）时重新采样：覆盖无监听期间 onLine / connection
  // 已经变化但没有事件可用的窗口，也让各组件实例与测试彼此不串状态。
  const fresh = readSnapshot();
  if (!sameSnapshot(snapshot, fresh)) {
    snapshot = fresh;
  }

  const onOnline = () => updateOnline(true);
  const onOffline = () => updateOnline(false);
  // 这些处理器不调用 preventDefault，可以声明为 passive，让浏览器跳过
  // 「是否会被取消默认行为」的等待。
  const passive: AddEventListenerOptions = { passive: true };

  window.addEventListener("online", onOnline, passive);
  window.addEventListener("offline", onOffline, passive);
  const connection = getConnection();
  connection?.addEventListener("change", onConnectionChange, passive);

  detachEvents = () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    connection?.removeEventListener("change", onConnectionChange);
    detachEvents = null;
  };
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  attachEvents();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      detachEvents?.();
    }
  };
};

const getSnapshot = (): NetworkState => snapshot;
const getServerSnapshot = (): NetworkState => SERVER_SNAPSHOT;

/**
 * 监听网络状态变化（上线/下线/网络制式变化）。
 *
 * 事件源与 ahooks `useNetwork` 完全一致：window 的 `online`/`offline`
 * 事件 + `navigator.connection` 的 `change` 事件；SSR 环境下
 * `typeof navigator === "undefined"` 时返回全 undefined 快照。
 */
export function useNetwork(): NetworkState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
