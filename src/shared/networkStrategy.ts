export type NetworkBadgeStatus =
  | "success"
  | "processing"
  | "default"
  | "error"
  | "warning";

export interface NetworkBadgeInfo {
  text: string;
  status: NetworkBadgeStatus;
}

/**
 * 网络类型 → 徽章文案/状态（上传、下载两条链路共用的展示映射）。
 * verbose=true 使用完整文案（「慢速 2G」「有线网络」），默认使用紧凑文案
 * （「慢2G」「有线」）。
 */
export const resolveNetworkBadgeInfo = (
  networkType: string,
  isOffline: boolean,
  verbose = false
): NetworkBadgeInfo => {
  if (isOffline) {
    return { text: "离线", status: "error" };
  }

  // 软离线：浏览器认为在线但实际不可达（连续上传失败降级）。
  if (networkType === "network-anomaly") {
    return { text: verbose ? "网络异常" : "网络异常", status: "warning" };
  }

  switch (networkType) {
    case "4g":
      return { text: "4G", status: "success" };
    case "3g":
      return { text: "3G", status: "processing" };
    case "2g":
      return { text: "2G", status: "warning" };
    case "slow-2g":
      return { text: verbose ? "慢速 2G" : "慢2G", status: "error" };
    case "wifi":
      return { text: "WiFi", status: "success" };
    case "ethernet":
      return { text: verbose ? "有线网络" : "有线", status: "success" };
    default:
      return { text: networkType || "未知", status: "default" };
  }
};

export interface NetworkProbe {
  rtt?: number;
  online?: boolean;
  effectiveType?: string;
  type?: string;
}

/**
 * 软离线跟踪器。
 *
 * `navigator.onLine === true` 只代表「有网络连接」，不代表「能访问服务器」
 * （连上 WiFi 但没有互联网、或网关把请求都丢到错误页即「假在线」）。
 * 为此引入软离线检测：累计连续上传终态失败次数，达到阈值即判定为软离线，
 * 触发与硬离线一致的「暂停新上传」降级；任意一次上传成功即清零，自动恢复。
 */
export interface SoftOfflineTracker {
  readonly threshold: number;
  /** 记录一次上传成功（含秒传），清零连续失败计数 */
  reportSuccess(): void;
  /** 记录一次上传终态失败，递增连续失败计数 */
  reportFailure(): void;
  /** 连续失败是否已触达阈值 */
  isSoftOffline(): boolean;
  /** 强制清零（如用户手动重试/恢复网络） */
  reset(): void;
}

export const createSoftOfflineTracker = (threshold = 3): SoftOfflineTracker => {
  let consecutiveFailures = 0;
  return {
    threshold,
    reportSuccess() {
      consecutiveFailures = 0;
    },
    reportFailure() {
      consecutiveFailures += 1;
    },
    isSoftOffline() {
      return consecutiveFailures >= threshold;
    },
    reset() {
      consecutiveFailures = 0;
    },
  };
};

export interface NetworkStrategyResult {
  networkType: string;
  isNetworkOffline: boolean;
  fileConcurrency: number;
  chunkConcurrency: number;
  chunkSize: number;
}

const resolveOffline = (online?: boolean): boolean => {
  const navigatorOnline =
    typeof window !== "undefined" &&
    typeof window.navigator !== "undefined" &&
    window.navigator.onLine === false;

  return online === false || navigatorOnline;
};

export const resolveNetworkStrategy = (
  probe: NetworkProbe,
  softOffline = false
): NetworkStrategyResult => {
  const { rtt, online, effectiveType, type } = probe;
  const hardOffline = resolveOffline(online);
  const isOffline = hardOffline || softOffline;

  let chunkConcurrency = 2;
  if (!isOffline) {
    if (typeof rtt === "number" && rtt > 0) {
      if (rtt <= 50) chunkConcurrency = 6;
      else if (rtt <= 100) chunkConcurrency = 4;
      else if (rtt <= 200) chunkConcurrency = 3;
      else if (rtt <= 500) chunkConcurrency = 2;
      else chunkConcurrency = 1;
    } else if (type === "wifi") {
      if (effectiveType === "4g") chunkConcurrency = 4;
      else if (effectiveType === "3g") chunkConcurrency = 3;
      else chunkConcurrency = 2;
    } else if (type === "ethernet") {
      chunkConcurrency = 4;
    } else if (effectiveType === "4g") {
      chunkConcurrency = 3;
    } else if (effectiveType === "3g") {
      chunkConcurrency = 2;
    } else if (effectiveType === "2g" || effectiveType === "slow-2g") {
      chunkConcurrency = 1;
    }
  } else {
    chunkConcurrency = 0;
  }

  let fileConcurrency = 2;
  if (!isOffline) {
    if (typeof rtt === "number" && rtt > 0) {
      if (rtt <= 50) fileConcurrency = 4;
      else if (rtt <= 100) fileConcurrency = 3;
      else if (rtt <= 200) fileConcurrency = 2;
      else fileConcurrency = 1;
    } else if (type === "wifi" || type === "ethernet") {
      fileConcurrency = 3;
    } else if (effectiveType === "4g") {
      fileConcurrency = 2;
    } else {
      fileConcurrency = 1;
    }
  } else {
    fileConcurrency = 0;
  }

  let chunkSize = 1024 * 1024;
  if (!isOffline) {
    if (typeof rtt === "number" && rtt > 0) {
      if (rtt <= 50) chunkSize = 8 * 1024 * 1024;
      else if (rtt <= 100) chunkSize = 4 * 1024 * 1024;
      else if (rtt <= 200) chunkSize = 2 * 1024 * 1024;
      else if (rtt <= 500) chunkSize = 1 * 1024 * 1024;
      else if (rtt <= 1000) chunkSize = 512 * 1024;
      else chunkSize = 256 * 1024;
    } else if (type === "wifi" || type === "ethernet") {
      chunkSize = 4 * 1024 * 1024;
    } else if (effectiveType === "4g") {
      chunkSize = 2 * 1024 * 1024;
    } else if (effectiveType === "2g" || effectiveType === "slow-2g") {
      chunkSize = 256 * 1024;
    }
  } else {
    chunkSize = 512 * 1024;
  }

  // 软离线（连续失败降级）：浏览器认为在线但实际不可达，用专属 networkType 区分，
  // 便于 UI 显示「网络异常」而非「离线」，同时与硬离线一致地暂停新上传。
  const networkType = isOffline
    ? hardOffline
      ? "offline"
      : "network-anomaly"
    : effectiveType || type || "unknown";

  return {
    networkType,
    // 仅硬离线反映在 isNetworkOffline（保留其语义）；软离线通过 networkType +
    // concurrency=0 体现，不污染硬离线 UI/逻辑。
    isNetworkOffline: hardOffline,
    fileConcurrency,
    chunkConcurrency,
    chunkSize,
  };
};
