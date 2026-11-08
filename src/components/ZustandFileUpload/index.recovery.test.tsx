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
});
