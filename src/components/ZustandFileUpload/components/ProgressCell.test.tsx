import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { UploadProvider } from "../context/UploadContext";
import { UploadStatus, type UploadFile } from "../types/upload";
import ProgressCell from "./ProgressCell";

const base = { fileId: "f1", fallbackProgress: 42 } as const;

const renderCell = (status: UploadFile["status"]) =>
  render(
    <UploadProvider settingsSource="props">
      <ProgressCell {...base} status={status} />
    </UploadProvider>,
  );

describe("ProgressCell", () => {
  it("DONE / INSTANT → 100% 且 success 状态", () => {
    const { rerender } = renderCell(UploadStatus.DONE);
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(
      document.querySelector(".rui-progress-status-success"),
    ).not.toBeNull();

    rerender(
      <UploadProvider settingsSource="props">
        <ProgressCell {...base} status={UploadStatus.INSTANT} />
      </UploadProvider>,
    );
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("ERROR → exception 状态 + fallback 进度", () => {
    renderCell(UploadStatus.ERROR);
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(
      document.querySelector(".rui-progress-status-exception"),
    ).not.toBeNull();
  });

  it("PAUSED → 普通状态（含继续提示），展示 fallback 进度", () => {
    renderCell(UploadStatus.PAUSED);
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("UPLOADING → active 状态 + 速率/剩余（默认 0）", () => {
    renderCell(UploadStatus.UPLOADING);
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("其它状态 → 普通状态 + fallback 进度", () => {
    renderCell("queued" as UploadFile["status"]);
    expect(screen.getByText("42%")).toBeInTheDocument();
  });
});
