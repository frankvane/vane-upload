import React from "react";
import { render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UploadProvider, type UploadContextType } from "./UploadContext";
import { useUploadContext } from "./useUploadContext";
import { useUploadEngine, type UploadEngine } from "./UploadEngineContext";

/**
 * VU-58 收尾：为 UploadProvider / UploadContext 编写行为断言单测。
 * 引擎创建逻辑（storage / fileRegistry / workerPool / store 工厂）全部 mock 掉，
 * 只验证：渲染 children、提供符合预期的 context value 形状、用传入 config 创建引擎。
 */

const h = vi.hoisted(() => {
  const createUploadStorage = vi.fn(() => ({
    setItem: vi.fn(() => Promise.resolve()),
    getItem: vi.fn(() => Promise.resolve(undefined)),
  }));
  const createFileRegistry = vi.fn(() => ({
    registerFileRef: vi.fn(),
    releaseAllFileRefs: vi.fn(),
  }));
  const createUploadWorkerPool = vi.fn(() => ({ dispose: vi.fn() }));
  const createUploadStore = vi.fn(() => ({
    getState: () => ({ files: [] }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  }));
  return { createUploadStorage, createFileRegistry, createUploadWorkerPool, createUploadStore };
});

vi.mock("../services/uploadStorageInstance", () => ({
  createUploadStorage: h.createUploadStorage,
}));

vi.mock("../services/fileRegistry", () => ({
  createFileRegistry: h.createFileRegistry,
}));

vi.mock("../services/uploadWorkerBridge", () => ({
  createUploadWorkerPool: h.createUploadWorkerPool,
}));

vi.mock("../store/upload", async () => {
  const ReactNS = await import("react");
  return {
    createUploadStore: h.createUploadStore,
    UploadStoreContext: ReactNS.createContext(null),
  };
});

const renderWithProvider = (
  ui: React.ReactNode,
  props: Record<string, unknown> = {}
) =>
  render(
    <UploadProvider settingsSource="props" {...props}>
      {ui}
    </UploadProvider>
  );

describe("UploadProvider / UploadContext", () => {
  it("能渲染 children", () => {
    const { getByText } = renderWithProvider(<div>hello-children</div>);
    expect(getByText("hello-children")).toBeInTheDocument();
  });

  it("提供符合预期形状的 context value（默认值 + 透传覆盖值）", () => {
    const captured: { value: UploadContextType; engine: UploadEngine }[] = [];
    const Probe = () => {
      captured.push({ value: useUploadContext(), engine: useUploadEngine() });
      return null;
    };

    const { rerender } = renderWithProvider(<Probe />);
    const def = captured.at(-1)!.value;

    // 默认形状：关键限制项与 UI 项均按 DEFAULT_CONFIG 透传
    expect(def.maxFiles).toBe(100);
    expect(def.maxFileSize).toBe(100 * 1024 * 1024);
    expect(def.autoUpload).toBe(true);
    expect(def.autoCleanup).toBe(true);
    expect(def.cleanupDelay).toBe(10);
    expect(def.uiMode).toBe("full");
    expect(def.settingsSource).toBe("props");
    expect(Array.isArray(def.allowedFileTypes)).toBe(true);
    expect(def.allowedFileTypes).toEqual([]);
    expect(typeof def.baseURL).toBe("string");
    expect(typeof def.uploadApi).toBe("string");
    // 缺省不应挂回调
    expect(def.onUploadStart).toBeUndefined();

    // 传入覆盖值后，context value 同步反映（行为而非“不抛错”）
    rerender(
      renderWithProvider(<Probe />, {
        maxFiles: 5,
        maxFileSize: 5 * 1024 * 1024,
        autoUpload: false,
        uiMode: "compact",
        onUploadStart: () => {},
      }).children
    );
    const over = captured.at(-1)!.value;
    expect(over.maxFiles).toBe(5);
    expect(over.maxFileSize).toBe(5 * 1024 * 1024);
    expect(over.autoUpload).toBe(false);
    expect(over.uiMode).toBe("compact");
    expect(typeof over.onUploadStart).toBe("function");
  });

  it("用传入 config 创建引擎，且 instanceId 决定引擎身份", () => {
    const captured: { value: UploadContextType; engine: UploadEngine }[] = [];
    const Probe = () => {
      captured.push({ value: useUploadContext(), engine: useUploadEngine() });
      return null;
    };

    // 未传 instanceId：回落 "default"，且四个工厂各被调用一次
    const { rerender } = renderWithProvider(<Probe />);
    const first = captured.at(-1)!;

    expect(h.createUploadStorage).toHaveBeenCalledTimes(1);
    expect(h.createFileRegistry).toHaveBeenCalledTimes(1);
    expect(h.createUploadWorkerPool).toHaveBeenCalledTimes(1);
    expect(h.createUploadStore).toHaveBeenCalledTimes(1);
    // createUploadStore 接收 storage（来自 createUploadStorage 的返回值）作为首参
    expect(h.createUploadStore).toHaveBeenCalledWith(h.createUploadStorage.mock.results[0]!.value);
    expect(first.engine.instanceId).toBe("default");
    expect(first.engine.storage).toBe(h.createUploadStorage.mock.results[0]!.value);

    // 传入 instanceId：重建引擎，且 storage 以该 instanceId 创建
    h.createUploadStorage.mockClear();
    rerender(renderWithProvider(<Probe />, { instanceId: "tenant-A" }).children);
    const second = captured.at(-1)!;

    expect(h.createUploadStorage).toHaveBeenCalledTimes(1);
    expect(h.createUploadStorage).toHaveBeenCalledWith("tenant-A");
    expect(second.engine.instanceId).toBe("tenant-A");
    expect(second.engine).not.toBe(first.engine);
  });
});
