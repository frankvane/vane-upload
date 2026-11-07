import { useEffect, useState } from "react";

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

/**
 * 监听网络状态变化（上线/下线/网络制式变化）。
 *
 * 事件源与 ahooks `useNetwork` 完全一致：window 的 `online`/`offline`
 * 事件 + `navigator.connection` 的 `change` 事件；SSR 环境下
 * `typeof navigator === "undefined"` 时返回全 undefined 快照。
 */
export function useNetwork(): NetworkState {
  const [state, setState] = useState<NetworkState>(() => ({
    online: typeof navigator === "undefined" ? undefined : navigator.onLine,
    ...readConnection(),
  }));

  useEffect(() => {
    const onOnline = () => {
      setState((prev) => ({ ...prev, online: true }));
    };
    const onOffline = () => {
      setState((prev) => ({ ...prev, online: false }));
    };
    const onConnectionChange = () => {
      setState((prev) => ({ ...prev, ...readConnection() }));
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    const connection = getConnection();
    connection?.addEventListener("change", onConnectionChange);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      connection?.removeEventListener("change", onConnectionChange);
    };
  }, []);

  return state;
}
