import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UploadProvider } from "./UploadContext";
import { useUploadEngine } from "./UploadEngineContext";
import { createFileRegistry } from "../services/fileRegistry";
import { createUploadStorage } from "../services/uploadStorageInstance";
import { createUploadWorkerPool } from "../services/uploadWorkerBridge";
import { createUploadStore } from "../store/upload";
import type { UploadFile } from "../types/upload";

/**
 * T3.2 单例治理 · 多实例隔离验收测试。
 *
 * 覆盖：每实例的 storage / fileRegistry / workerPool / store 均相互隔离，
 * 同页多个 <FileUpload instanceId=...> 互不串数据；不传 instanceId 时回落默认
 * storeName，保持单实例刷新续传行为。
 */
describe("T3.2 每实例引擎隔离", () => {
  describe("工厂级隔离", () => {
    it("不同 instanceId 的 storage 写入互不串", async () => {
      const sa = createUploadStorage("alpha");
      const sb = createUploadStorage("beta");
      const sd = createUploadStorage();

      await sa.setItem("k", { id: "k", fileName: "x.bin" } as unknown as UploadFile);
      expect(await sa.getItem("k")).not.toBeNull();
      expect(await sb.getItem("k")).toBeNull();
      expect(await sd.getItem("k")).toBeNull();

      await sa.clear();
      await sb.clear();
      await sd.clear();
    });

    it("不同实例的 fileRegistry 互不串", () => {
      const ra = createFileRegistry();
      const rb = createFileRegistry();
      const f = new File([new Uint8Array(8)], "y.bin");

      ra.registerFileRef("y", f);
      expect(ra.getFileRef("y")).toBe(f);
      expect(rb.getFileRef("y")).toBeUndefined();
      expect(ra.fileRefCount()).toBe(1);
      expect(rb.fileRefCount()).toBe(0);
    });

    it("不同实例的 workerPool 为独立对象且各自可 dispose", () => {
      const pa = createUploadWorkerPool();
      const pb = createUploadWorkerPool();
      expect(pa).not.toBe(pb);
      expect(typeof pa.runUploadTask).toBe("function");
      expect(typeof pa.cancelUploadTask).toBe("function");
      expect(typeof pa.dispose).toBe("function");
      expect(() => pa.dispose()).not.toThrow();
      expect(() => pb.dispose()).not.toThrow();
    });

    it("不同实例的 store 状态互不串", () => {
      const storeA = createUploadStore(createUploadStorage("sa"));
      const storeB = createUploadStore(createUploadStorage("sb"));

      act(() => {
        storeA.getState().setFiles([{ id: "1" } as unknown as UploadFile]);
      });

      expect(storeA.getState().files).toHaveLength(1);
      expect(storeB.getState().files).toHaveLength(0);
    });
  });

  describe("UploadProvider 上下文隔离", () => {
    const renderEngine = (instanceId?: string) =>
      renderHook(() => useUploadEngine(), {
        wrapper: ({ children }) => (
          <UploadProvider instanceId={instanceId}>{children}</UploadProvider>
        ),
      });

    it("按 instanceId 下发隔离的引擎（身份 + 资源互不串）", async () => {
      const a = renderEngine("alpha");
      const b = renderEngine("beta");
      const d = renderEngine();

      expect(a.result.current.instanceId).toBe("alpha");
      expect(b.result.current.instanceId).toBe("beta");
      expect(d.result.current.instanceId).toBe("default");

      // 身份隔离
      expect(a.result.current.storage).not.toBe(b.result.current.storage);
      expect(a.result.current.fileRegistry).not.toBe(b.result.current.fileRegistry);
      expect(a.result.current.workerPool).not.toBe(b.result.current.workerPool);
      expect(a.result.current.store).not.toBe(b.result.current.store);

      // store 状态隔离
      act(() => {
        a.result.current.store.getState().setFiles([
          { id: "x" } as unknown as UploadFile,
        ]);
      });
      expect(a.result.current.store.getState().files).toHaveLength(1);
      expect(b.result.current.store.getState().files).toHaveLength(0);

      // fileRegistry 隔离
      const f = new File([new Uint8Array(8)], "z.bin");
      a.result.current.fileRegistry.registerFileRef("z", f);
      expect(a.result.current.fileRegistry.getFileRef("z")).toBe(f);
      expect(b.result.current.fileRegistry.getFileRef("z")).toBeUndefined();

      // storage 隔离（真实 IndexedDB，依赖 fake-indexeddb/auto）
      await a.result.current.storage.setItem(
        "z",
        { id: "z" } as unknown as UploadFile
      );
      expect(await a.result.current.storage.getItem("z")).not.toBeNull();
      expect(await b.result.current.storage.getItem("z")).toBeNull();

      await a.result.current.storage.clear();
      await b.result.current.storage.clear();

      // 卸载时仅释放自身资源，不影响另一实例
      expect(() => b.result.current.workerPool.dispose()).not.toThrow();

      a.unmount();
      b.unmount();
      d.unmount();
    });
  });
});
