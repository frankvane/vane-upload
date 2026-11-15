import { useEffect, useRef } from "react";

import { resolveNetworkStrategy } from "../../../shared/networkStrategy";
import { useNetwork } from "../../../shared/useNetwork";
import { useUploadStore, useUploadStoreApi } from "../store/upload";

/**
 * 网络状态检测钩子
 * 监听网络状态变化，更新Zustand store中的网络参数
 */
export function useNetworkDetection() {
  const network = useNetwork();
  const { rtt, online, effectiveType, type } = network;
  const store = useUploadStoreApi();
  // 软离线：由上传结果信号（连续失败）驱动，与硬离线（navigator.onLine）合并解析。
  const softOffline = useUploadStore((s) => s.softOffline);

  const prevSignatureRef = useRef("");

  useEffect(() => {
    const signature = `${rtt ?? "na"}|${online ?? "na"}|${effectiveType ?? "na"}|${
      type ?? "na"
    }|${softOffline ? "so" : "no"}`;

    if (prevSignatureRef.current === signature) {
      return;
    }
    prevSignatureRef.current = signature;

    const strategy = resolveNetworkStrategy(
      {
        rtt,
        online,
        effectiveType,
        type,
      },
      softOffline
    );

    store.setState(strategy);
  }, [rtt, online, effectiveType, type, softOffline, store]);
}
