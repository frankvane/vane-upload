import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import ZustandFileUpload from "./index";

describe("ZustandFileUpload simple mode", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows only select + progress list controls in simple mode", async () => {
    render(
      <ZustandFileUpload
        autoUpload={true}
        autoCleanup={true}
        cleanupDelay={5}
        uiMode="simple"
        settingsSource="props"
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "选择文件" })).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "上传文件" })).toBeNull();
    expect(screen.queryByRole("button", { name: "清除列表" })).toBeNull();
    expect(screen.queryByText("批量重试")).toBeNull();
    expect(screen.queryByText("重试失败文件")).toBeNull();
    // simple 模式仍保留操作列（失败可重试、可删除）
    expect(screen.getByText("操作")).toBeInTheDocument();
  });
});
