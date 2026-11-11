import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import PercentDisplay from "./PercentDisplay";

describe("PercentDisplay", () => {
  it("error 状态映射到 Progress 的 exception 状态", () => {
    render(<PercentDisplay percent={42.7} status="error" />);
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(
      document.querySelector(".rui-progress-status-exception"),
    ).not.toBeNull();
  });

  it("normal 状态不注入异常 class，进度按 floor 取整", () => {
    const { container } = render(
      <PercentDisplay percent={30.9} status="normal" />,
    );
    expect(
      document.querySelector(".rui-progress-status-exception"),
    ).toBeNull();
    expect(screen.getByText("30%")).toBeInTheDocument();
  });

  it("speed/eta 为 0 时不展示速率与剩余明细", () => {
    const { container } = render(
      <PercentDisplay percent={50} status="normal" speed={0} eta={0} />,
    );
    expect(container.textContent).not.toContain("MB/s");
    expect(container.textContent).not.toContain("剩余");
  });

  it("speed 较大展示 MB/s，eta 较大展示「分X秒」", () => {
    const { container } = render(
      <PercentDisplay
        percent={50}
        status="active"
        speed={2 * 1024 * 1024}
        eta={125}
      />,
    );
    expect(container.textContent).toContain("2.0 MB/s");
    expect(container.textContent).toContain("2分5秒");
  });
});
