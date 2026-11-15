import React from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UploadProvider } from "../context/UploadContext";
import { useUploadEngine } from "../context/UploadEngineContext";
import { UploadStatus } from "../types/upload";
import ProgressCell from "./ProgressCell";

// P2-perf 回归：setProgressDetail 改为原地增量改写单键（O(1)）并自增
// progressVersion，而非整体展开三张 map。本用例锁定「原地改值后，订阅该
// fileId 的 ProgressCell 仍能正确重渲染出新进度」，且「未更新的单元格不被波及」。
let storeRef: ReturnType<typeof useUploadEngine>["store"] | null = null;

const Harness = ({ ids }: { ids: string[] }) => {
  const engine = useUploadEngine();
  storeRef = engine.store;
  return (
    <>
      {ids.map((id) => (
        <ProgressCell
          key={id}
          fileId={id}
          status={UploadStatus.UPLOADING}
          fallbackProgress={0}
        />
      ))}
    </>
  );
};

describe("ProgressCell 进度增量更新（原地 setProgressDetail 后正确重渲染）", () => {
  it("原地改写单键后对应单元格显示新进度，其余单元格不受影响", () => {
    storeRef = null;
    const { container } = render(
      <UploadProvider settingsSource="props">
        <Harness ids={["f-1", "f-2"]} />
      </UploadProvider>,
    );
    const store = storeRef!;

    // 初始：两个单元格均为 0%
    expect(container.textContent).toContain("0%");

    act(() => {
      store.getState().setProgressDetail("f-1", {
        progress: 50,
        speed: 1024,
        eta: 9,
      });
    });

    // f-1 更新为 50%
    expect(container.textContent).toContain("50%");
    // f-2 仍为 0%，未被 f-1 的更新波及（useShallow 按本 fileId 原始值比较）
    expect(container.textContent).toContain("0%");
    expect(container.textContent).not.toContain("100%");

    act(() => {
      store.getState().setProgressDetail("f-2", {
        progress: 80,
        speed: 2048,
        eta: 3,
      });
    });

    // f-2 更新为 80%，f-1 维持 50%
    expect(container.textContent).toContain("80%");
    expect(container.textContent).toContain("50%");
  });
});
