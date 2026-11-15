import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UploadProvider } from "./context/UploadContext";
import { useUploadContext } from "./context/useUploadContext";
import type { UploadUIMode } from "./types/upload";

const Probe = () => {
  const { messageLevel } = useUploadContext();
  return <span data-testid="level">{messageLevel}</span>;
};

const renderWith = (uiMode: UploadUIMode, messageLevel?: "all" | "warning-error" | "none") =>
  render(
    <UploadProvider uiMode={uiMode} messageLevel={messageLevel} settingsSource="props">
      <Probe />
    </UploadProvider>
  );

describe("messageLevel 有效值（UploadProvider）", () => {
  it("full / simple 模式默认 all", () => {
    for (const mode of ["full", "simple"] as const) {
      const { unmount } = renderWith(mode);
      expect(screen.getByTestId("level")).toHaveTextContent("all");
      unmount();
    }
  });

  it("minimal 极简模式默认 warning-error（降噪）", () => {
    renderWith("minimal");
    expect(screen.getByTestId("level")).toHaveTextContent("warning-error");
  });

  it("显式 messageLevel 覆盖 mode 默认值", () => {
    const { unmount } = renderWith("minimal", "all");
    expect(screen.getByTestId("level")).toHaveTextContent("all");
    unmount();

    renderWith("full", "none");
    expect(screen.getByTestId("level")).toHaveTextContent("none");
  });
});
