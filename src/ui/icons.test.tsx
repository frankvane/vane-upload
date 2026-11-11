import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { SettingOutlined, UploadOutlined } from "./icons";

describe("ui/icons", () => {
  it("渲染 svg 且带统一 viewBox 与 data-icon", () => {
    const { container } = render(<UploadOutlined />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg?.getAttribute("viewBox")).toBe("64 64 896 896");
    expect(svg?.getAttribute("data-icon")).toBe("UploadOutlined");
    expect(svg?.querySelector("path")).not.toBeNull();
  });

  it("spin 注入旋转动画样式", () => {
    const { container } = render(<SettingOutlined spin />);
    const svg = container.querySelector("svg")!;
    expect(svg.style.animation).toContain("rui-icon-spin");
  });

  it("rotate 注入 transform 旋转", () => {
    const { container } = render(<SettingOutlined rotate={90} />);
    const svg = container.querySelector("svg")!;
    expect(svg.style.transform).toContain("rotate(90deg)");
  });

  it("透传原生 svg 属性（如 aria-label）", () => {
    const { container } = render(<UploadOutlined aria-label="上传" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-label")).toBe("上传");
  });
});
