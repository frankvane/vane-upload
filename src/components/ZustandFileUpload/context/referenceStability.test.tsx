import React from "react";
import { act, render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UploadProvider, type UploadContextType } from "./UploadContext";
import { useUploadContext } from "./useUploadContext";
import { useUploadEngine, type UploadEngine } from "./UploadEngineContext";
import { useBatchUploader } from "../hooks/useBatchUploader";
import { useFileOperations } from "../hooks/useFileOperations";
import type { UploadColumnKey } from "../types/upload";

/**
 * VU-16 / VU-42 / VU-45 回归：引用稳定性是这个项目重渲染问题的根因，
 * 这里直接断言「身份不变」，而不是只断言「方法存在 / 不抛错」。
 */
describe("VU-16 / VU-45：UploadProvider 引用稳定性", () => {
  interface HostProps {
    tick: number;
    allowed: string[];
    columns?: UploadColumnKey[];
    instanceId: string;
  }

  const captured: { value: UploadContextType; engine: UploadEngine }[] = [];

  const Probe = () => {
    captured.push({ value: useUploadContext(), engine: useUploadEngine() });
    return null;
  };

  const Host = ({ tick, allowed, columns, instanceId }: HostProps) => (
    <UploadProvider
      settingsSource="props"
      allowedFileTypes={allowed}
      visibleColumns={columns}
      instanceId={instanceId}
    >
      <Probe />
      <span>{tick}</span>
    </UploadProvider>
  );

  it("宿主无关重渲染 + 内容相同的新数组，不更换 context / engine 身份", () => {
    captured.length = 0;
    const columns: UploadColumnKey[] = ["fileName", "progress"];
    const { rerender } = render(
      <Host tick={0} allowed={[".png", "image/jpeg"]} columns={columns} instanceId="alpha" />
    );
    const first = captured.at(-1)!;

    // tick 变化 + 两个数组都换成内容相同的新引用
    rerender(
      <Host tick={1} allowed={[".png", "image/jpeg"]} columns={[...columns]} instanceId="alpha" />
    );
    const second = captured.at(-1)!;

    expect(second.value).toBe(first.value);
    expect(second.engine).toBe(first.engine);
    expect(second.value.allowedFileTypes).toBe(first.value.allowedFileTypes);
    expect(second.value.visibleColumns).toBe(first.value.visibleColumns);
    expect(second.value.allowedFileTypes).toEqual([".png", "image/jpeg"]);
  });

  it("instanceId 变更重建引擎，并释放旧引擎的 workerPool / fileRegistry", () => {
    captured.length = 0;
    const { rerender } = render(
      <Host tick={0} allowed={[]} instanceId="alpha" />
    );
    const first = captured.at(-1)!;
    const disposeSpy = vi.spyOn(first.engine.workerPool, "dispose");
    const releaseSpy = vi.spyOn(first.engine.fileRegistry, "releaseAllFileRefs");

    rerender(<Host tick={1} allowed={[]} instanceId="beta" />);
    const second = captured.at(-1)!;

    expect(second.engine).not.toBe(first.engine);
    expect(second.engine.instanceId).toBe("beta");
    expect(second.engine.store).not.toBe(first.engine.store);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it("visibleColumns 缺省/空数组语义不变（不把 [] 误判成 undefined）", () => {
    captured.length = 0;
    const { rerender } = render(<Host tick={0} allowed={[]} columns={[]} instanceId="a" />);
    expect(captured.at(-1)!.value.visibleColumns).toEqual([]);

    rerender(<Host tick={1} allowed={[]} instanceId="a" />);
    expect(captured.at(-1)!.value.visibleColumns).toBeUndefined();
  });
});

describe("VU-42：actions 身份稳定，进度更新不触发编排 hook 重渲染", () => {
  it("rerender 与 setProgressDetail 都不重建 batchUploader / fileOperations", () => {
    let renderCount = 0;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <UploadProvider settingsSource="props">{children}</UploadProvider>
    );

    const { result, rerender } = renderHook(
      () => {
        renderCount += 1;
        const engine = useUploadEngine();
        const batch = useBatchUploader();
        const ops = useFileOperations(batch);
        return { batch, ops, store: engine.store };
      },
      { wrapper }
    );

    const first = result.current;
    expect(renderCount).toBe(1);

    rerender();
    expect(renderCount).toBe(2);
    expect(result.current.batch).toBe(first.batch);
    expect(result.current.batch.uploadAll).toBe(first.batch.uploadAll);
    expect(result.current.batch.cancelUpload).toBe(first.batch.cancelUpload);
    expect(result.current.ops).toBe(first.ops);
    expect(result.current.ops.handleDeleteFile).toBe(first.ops.handleDeleteFile);

    // 高频进度更新不得让编排层重渲染（进度由行内组件自行订阅）
    act(() => {
      result.current.store.getState().setProgressDetail("f-1", {
        progress: 42,
        speed: 1024,
        eta: 9,
      });
    });
    expect(renderCount).toBe(2);
    expect(result.current.batch).toBe(first.batch);
    expect(result.current.ops).toBe(first.ops);
  });
});
