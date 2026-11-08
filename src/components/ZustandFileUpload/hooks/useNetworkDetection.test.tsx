/**
 * useNetworkDetection 行为断言单测（VU-58 收尾）。
 *
 * mock `useNetwork`（替换 navigator/网络事件源）与 store（`useUploadStoreApi`），
 * 验证 hook 在挂载时把解析出的网络策略写入 store，并在网络签名不变时去重、
 * 变化时再次写入。resolveNetworkStrategy 保持真实，以断言策略集成正确。
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkState } from "../../../shared/useNetwork";

const h = vi.hoisted(() => ({
  network: {
    online: true,
    rtt: 30,
    effectiveType: "4g",
    type: "wifi",
  } as NetworkState,
  storeApi: {
    setState: vi.fn(),
    getState: vi.fn(() => ({}) as Record<string, unknown>),
  },
}));

vi.mock("../../../shared/useNetwork", () => ({
  useNetwork: vi.fn(() => h.network),
}));

vi.mock("../store/upload", () => ({
  useUploadStore: vi.fn(),
  useUploadStoreApi: vi.fn(() => h.storeApi),
  createUploadStore: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  UploadStoreContext: {} as any,
}));

import { resolveNetworkStrategy } from "../../../shared/networkStrategy";
import { useNetworkDetection } from "./useNetworkDetection";

describe("useNetworkDetection（网络策略写入与去重）", () => {
  beforeEach(() => {
    h.network = { online: true, rtt: 30, effectiveType: "4g", type: "wifi" };
    h.storeApi.setState.mockClear();
  });

  it("挂载时把解析出的网络策略写入 store", () => {
    renderHook(() => useNetworkDetection());

    expect(h.storeApi.setState).toHaveBeenCalledTimes(1);
    const expected = resolveNetworkStrategy({
      rtt: h.network.rtt,
      online: h.network.online,
      effectiveType: h.network.effectiveType,
      type: h.network.type,
    });
    expect(h.storeApi.setState).toHaveBeenCalledWith(
      expect.objectContaining({
        networkType: expected.networkType,
        isNetworkOffline: expected.isNetworkOffline,
        fileConcurrency: expected.fileConcurrency,
        chunkConcurrency: expected.chunkConcurrency,
        chunkSize: expected.chunkSize,
      })
    );
    // 低延迟 4G 应得到更高并发与更大分片
    expect(expected.networkType).toBe("4g");
    expect(expected.isNetworkOffline).toBe(false);
    expect(expected.fileConcurrency).toBe(4);
    expect(expected.chunkConcurrency).toBe(6);
    expect(expected.chunkSize).toBe(8 * 1024 * 1024);
  });

  it("网络签名未变时，重复渲染不会再次写入 store", () => {
    const { rerender } = renderHook(() => useNetworkDetection());
    expect(h.storeApi.setState).toHaveBeenCalledTimes(1);

    act(() => {
      rerender();
    });
    expect(h.storeApi.setState).toHaveBeenCalledTimes(1);
  });

  it("网络状态变化（离线）时再次写入 store，并标记离线", () => {
    const { rerender } = renderHook(() => useNetworkDetection());
    expect(h.storeApi.setState).toHaveBeenCalledTimes(1);

    act(() => {
      h.network = {
        online: false,
        rtt: undefined,
        effectiveType: undefined,
        type: undefined,
      };
      rerender();
    });

    expect(h.storeApi.setState).toHaveBeenCalledTimes(2);
    const lastCall = h.storeApi.setState.mock.calls.at(-1)![0] as Record<
      string,
      unknown
    >;
    expect(lastCall.isNetworkOffline).toBe(true);
    expect(lastCall.networkType).toBe("offline");
  });

  it("高延迟低速网络解析出更保守的并发与分片", () => {
    act(() => {
      h.network = {
        online: true,
        rtt: 1500,
        effectiveType: "slow-2g",
        type: "cellular",
      };
    });
    renderHook(() => useNetworkDetection());

    const expected = resolveNetworkStrategy({
      rtt: 1500,
      online: true,
      effectiveType: "slow-2g",
      type: "cellular",
    });
    expect(expected.fileConcurrency).toBe(1);
    expect(expected.chunkConcurrency).toBe(1);
    expect(expected.chunkSize).toBe(256 * 1024);
    expect(h.storeApi.setState).toHaveBeenCalledWith(
      expect.objectContaining({
        networkType: "slow-2g",
        fileConcurrency: 1,
        chunkConcurrency: 1,
        chunkSize: 256 * 1024,
      })
    );
  });
});
