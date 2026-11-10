import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode, type ComponentType, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recoverMock = vi.hoisted(() => vi.fn());

vi.mock("./services/uploadStorage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./services/uploadStorage")>();
  return { ...actual, recoverUploadQueueOnMount: recoverMock };
});

import ZustandFileUpload from "./index";
import { UploadStatus } from "./types/upload";

const restoredFile = {
  id: "restored-1",
  fileName: "restored.bin",
  fileSize: 2048,
  fileType: "application/octet-stream",
  lastModified: 1,
  status: UploadStatus.ERROR,
  progress: 0,
  createdAt: 1,
  order: 1,
  errorMessage: "请重新选择文件",
  awaitingReselect: true,
};

const snapshot = {
  files: [restoredFile],
  summary: {
    totalInterrupted: 1,
    recoveredCount: 0,
    missingFileRefCount: 1,
  },
  writeCount: 0,
};

const renderUpload = (
  Wrapper?: ComponentType<{ children?: ReactNode }>
) =>
  render(
    <ZustandFileUpload
      autoUpload={false}
      autoCleanup={false}
      cleanupDelay={5}
      uiMode="simple"
      settingsSource="props"
    />,
    Wrapper ? { wrapper: Wrapper } : undefined
  );

describe("ZustandFileUpload 挂载恢复（E2E-R1）", () => {
  beforeEach(() => {
    localStorage.clear();
    recoverMock.mockReset();
    recoverMock.mockResolvedValue(snapshot);
  });

  it("单次挂载时把 IndexedDB 快照应用回列表", async () => {
    renderUpload();

    expect(await screen.findByText("restored.bin")).toBeInTheDocument();
    expect(recoverMock).toHaveBeenCalledTimes(1);
  });

  it("StrictMode 双挂载仍只恢复一次且不产生重复行", async () => {
    renderUpload(StrictMode);

    expect(await screen.findByText("restored.bin")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByText("restored.bin")).toHaveLength(1);
    });
    // 两次挂载共享同一个恢复 Promise，IDB 快照只读一次。
    expect(recoverMock).toHaveBeenCalledTimes(1);
  });

  it("T-06：instanceId 变更后不复用上一个实例的恢复 Promise（防跨实例串台）", async () => {
    const emptySnapshot = {
      files: [] as typeof snapshot.files,
      summary: {
        totalInterrupted: 0,
        recoveredCount: 0,
        missingFileRefCount: 0,
      },
      writeCount: 0,
    };
    let call = 0;
    recoverMock.mockImplementation(async () => {
      call += 1;
      // 只有 alpha 实例的存储分区里有数据；beta 是全新分区。
      return call === 1 ? snapshot : emptySnapshot;
    });

    const { rerender } = render(
      <ZustandFileUpload
        instanceId="alpha"
        autoUpload={false}
        autoCleanup={false}
        cleanupDelay={5}
        uiMode="simple"
        settingsSource="props"
      />
    );
    expect(await screen.findByText("restored.bin")).toBeInTheDocument();

    rerender(
      <ZustandFileUpload
        instanceId="beta"
        autoUpload={false}
        autoCleanup={false}
        cleanupDelay={5}
        uiMode="simple"
        settingsSource="props"
      />
    );

    // 换实例后必须为新引擎重新读一次快照……
    await waitFor(() => expect(recoverMock).toHaveBeenCalledTimes(2));
    // ……且绝不能把 alpha 的队列写进 beta 的列表（旧实现会复用旧 Promise）。
    await waitFor(() => expect(screen.queryByText("restored.bin")).toBeNull());
  });
});
