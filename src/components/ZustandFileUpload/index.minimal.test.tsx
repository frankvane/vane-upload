import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import ZustandFileUpload from "./index";

describe("ZustandFileUpload minimal 极简模式", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const renderMinimal = (autoUpload = false) =>
    render(
      <ZustandFileUpload
        autoUpload={autoUpload}
        autoCleanup={true}
        cleanupDelay={5}
        uiMode="minimal"
        settingsSource="props"
      />
    );

  it("只保留选择文件按钮，无上传/清除/重试按钮", async () => {
    renderMinimal();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "选择文件" })
      ).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "上传文件" })).toBeNull();
    expect(screen.queryByRole("button", { name: "清除列表" })).toBeNull();
    expect(screen.queryByText("批量重试")).toBeNull();
    expect(screen.queryByText("重试失败文件")).toBeNull();
  });

  it("不渲染文件表格、批次信息与存储统计抽屉", async () => {
    renderMinimal();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "选择文件" })
      ).toBeInTheDocument();
    });

    // 表格表头（文件名/分片数/操作）均不应出现
    expect(screen.queryByText("文件名")).toBeNull();
    expect(screen.queryByText("分片数")).toBeNull();
    expect(screen.queryByText("操作")).toBeNull();
    // 网络徽章/自动上传开关等工具栏控件也不应出现
    expect(screen.queryByText("自动上传")).toBeNull();
    expect(screen.queryByText("自动清理")).toBeNull();
  });

  it("空列表时不显示进度条（细线仅在有文件时出现）", async () => {
    renderMinimal();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "选择文件" })
      ).toBeInTheDocument();
    });

    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
