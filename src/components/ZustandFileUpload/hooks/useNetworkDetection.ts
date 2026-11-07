import { useEffect, useRef } from "react";

import { resolveNetworkStrategy } from "../../../shared/networkStrategy";
import { useNetwork } from "../../../shared/useNetwork";
import { useUploadStoreApi } from "../store/upload";

/**
 * 网络状态检测钩子
 * 监听网络状态变化，更新Zustand store中的网络参数
 */
export function useNetworkDetection() {
  const network = useNetwork();
  const { rtt, online, effectiveType, type } = network;
  const store = useUploadStoreApi();

  const prevSignatureRef = useRef("");

  useEffect(() => {
    const signature = `${rtt ?? "na"}|${online ?? "na"}|${effectiveType ?? "na"}|${
      type ?? "na"
    }`;

    if (prevSignatureRef.current === signature) {
      return;
    }
    prevSignatureRef.current = signature;

    const strategy = resolveNetworkStrategy({
      rtt,
      online,
      effectiveType,
      type,
    });

    store.setState(strategy);
  }, [rtt, online, effectiveType, type, store]);
}
