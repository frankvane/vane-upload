import { describe, expect, it } from "vitest";
import {
  resolveNetworkBadgeInfo,
  resolveNetworkStrategy,
} from "./networkStrategy";

describe("resolveNetworkStrategy", () => {
  it("marks network as offline when online=false", () => {
    const result = resolveNetworkStrategy({
      online: false,
      effectiveType: "4g",
      type: "wifi",
      rtt: 40,
    });

    expect(result.isNetworkOffline).toBe(true);
    expect(result.networkType).toBe("offline");
    expect(result.fileConcurrency).toBe(0);
    expect(result.chunkConcurrency).toBe(0);
    expect(result.chunkSize).toBe(512 * 1024);
  });

  it("uses low-latency profile for strong rtt", () => {
    const result = resolveNetworkStrategy({
      online: true,
      rtt: 45,
      effectiveType: "4g",
      type: "wifi",
    });

    expect(result.isNetworkOffline).toBe(false);
    expect(result.fileConcurrency).toBe(4);
    expect(result.chunkConcurrency).toBe(6);
    expect(result.chunkSize).toBe(8 * 1024 * 1024);
  });

  it("resolves wifi + 4g fallback profile", () => {
    const result = resolveNetworkStrategy({
      online: true,
      effectiveType: "4g",
      type: "wifi",
    });

    expect(result.networkType).toBe("4g");
    expect(result.fileConcurrency).toBe(3);
    expect(result.chunkConcurrency).toBe(4);
    expect(result.chunkSize).toBe(4 * 1024 * 1024);
  });

  it("applies conservative profile for 2g network", () => {
    const result = resolveNetworkStrategy({
      online: true,
      effectiveType: "2g",
      type: "cellular",
    });

    expect(result.fileConcurrency).toBe(1);
    expect(result.chunkConcurrency).toBe(1);
    expect(result.chunkSize).toBe(256 * 1024);
  });

  it.each([
    [50, 6, 4, 8 * 1024 * 1024],
    [100, 4, 3, 4 * 1024 * 1024],
    [200, 3, 2, 2 * 1024 * 1024],
    [500, 2, 1, 1024 * 1024],
    [1000, 1, 1, 512 * 1024],
    [1001, 1, 1, 256 * 1024],
  ])(
    "maps rtt=%ims to chunkConc=%i fileConc=%i chunkSize=%i",
    (rtt, chunkConcurrency, fileConcurrency, chunkSize) => {
      const result = resolveNetworkStrategy({ online: true, rtt });

      expect(result.chunkConcurrency).toBe(chunkConcurrency);
      expect(result.fileConcurrency).toBe(fileConcurrency);
      expect(result.chunkSize).toBe(chunkSize);
      expect(result.isNetworkOffline).toBe(false);
    },
  );

  it("treats ethernet as strong connection without rtt", () => {
    const result = resolveNetworkStrategy({
      online: true,
      type: "ethernet",
    });

    expect(result.networkType).toBe("ethernet");
    expect(result.fileConcurrency).toBe(3);
    expect(result.chunkConcurrency).toBe(4);
    expect(result.chunkSize).toBe(4 * 1024 * 1024);
  });

  it.each([
    ["4g", 2, 3, 2 * 1024 * 1024],
    ["3g", 1, 2, 1024 * 1024],
    ["slow-2g", 1, 1, 256 * 1024],
  ])(
    "derives profile from effectiveType=%s alone",
    (effectiveType, fileConcurrency, chunkConcurrency, chunkSize) => {
      const result = resolveNetworkStrategy({ online: true, effectiveType });

      expect(result.networkType).toBe(effectiveType);
      expect(result.fileConcurrency).toBe(fileConcurrency);
      expect(result.chunkConcurrency).toBe(chunkConcurrency);
      expect(result.chunkSize).toBe(chunkSize);
    },
  );

  it("falls back to conservative defaults when nothing is known", () => {
    const result = resolveNetworkStrategy({ online: true });

    expect(result.networkType).toBe("unknown");
    expect(result.fileConcurrency).toBe(1);
    expect(result.chunkConcurrency).toBe(2);
    expect(result.chunkSize).toBe(1024 * 1024);
  });

  it("falls back to navigator.onLine when online is undefined", () => {
    const original = Object.getOwnPropertyDescriptor(
      window.navigator,
      "onLine",
    );
    Object.defineProperty(window.navigator, "onLine", {
      value: false,
      configurable: true,
    });

    try {
      const result = resolveNetworkStrategy({});

      expect(result.isNetworkOffline).toBe(true);
      expect(result.networkType).toBe("offline");
      expect(result.fileConcurrency).toBe(0);
      expect(result.chunkConcurrency).toBe(0);
      expect(result.chunkSize).toBe(512 * 1024);
    } finally {
      if (original) {
        Object.defineProperty(window.navigator, "onLine", original);
      }
    }
  });

  it("ignores rtt when offline", () => {
    const result = resolveNetworkStrategy({
      online: false,
      rtt: 10,
      effectiveType: "4g",
      type: "wifi",
    });

    expect(result.isNetworkOffline).toBe(true);
    expect(result.fileConcurrency).toBe(0);
    expect(result.chunkConcurrency).toBe(0);
    expect(result.chunkSize).toBe(512 * 1024);
  });
});

describe("resolveNetworkBadgeInfo", () => {
  it("marks offline as error", () => {
    expect(resolveNetworkBadgeInfo("4g", true)).toEqual({
      text: "离线",
      status: "error",
    });
  });

  it.each([
    ["4g", "4G", "success"],
    ["3g", "3G", "processing"],
    ["2g", "2G", "warning"],
    ["slow-2g", "慢2G", "error"],
    ["wifi", "WiFi", "success"],
    ["ethernet", "有线", "success"],
  ])("maps %s to compact badge", (networkType, text, status) => {
    expect(resolveNetworkBadgeInfo(networkType, false)).toEqual({
      text,
      status,
    });
  });

  it("uses verbose labels when requested", () => {
    expect(resolveNetworkBadgeInfo("slow-2g", false, true).text).toBe(
      "慢速 2G",
    );
    expect(resolveNetworkBadgeInfo("ethernet", false, true).text).toBe(
      "有线网络",
    );
  });

  it("falls back to raw networkType or 未知", () => {
    expect(resolveNetworkBadgeInfo("5g", false)).toEqual({
      text: "5g",
      status: "default",
    });
    expect(resolveNetworkBadgeInfo("", false).text).toBe("未知");
  });
});
