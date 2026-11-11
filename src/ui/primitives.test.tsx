import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Empty,
  InputNumber,
  Progress,
  Slider,
  Spin,
  Statistic,
  Switch,
  Tag,
} from "./primitives";

describe("ui/primitives · Button", () => {
  it("渲染默认/主按钮，onClick 触发", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>选择文件</Button>);
    const btn = screen.getByRole("button", { name: "选择文件" });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("primary / danger / loading / disabled 注入对应 class 并禁用", () => {
    const { container } = render(
      <Button type="primary" danger loading disabled>
        x
      </Button>,
    );
    const btn = container.querySelector("button")!;
    expect(btn.className).toContain("rui-btn-primary");
    expect(btn.className).toContain("rui-btn-dangerous");
    expect(btn.className).toContain("rui-btn-loading");
    expect(btn.className).toContain("rui-btn-disabled");
    expect(btn).toBeDisabled();
  });

  it("block / size=small 注入对应 class", () => {
    const { container } = render(
      <Button block size="small">
        x
      </Button>,
    );
    const btn = container.querySelector("button")!;
    expect(btn.className).toContain("rui-btn-block");
    expect(btn.className).toContain("rui-btn-sm");
  });
});

describe("ui/primitives · Tag / Badge", () => {
  it("Tag 按 color 拼 class，bordered=false 时透明边框", () => {
    const { container } = render(<Tag color="green">ok</Tag>);
    expect(container.querySelector(".rui-tag-green")).toBeInTheDocument();
  });

  it("Tag bordered=false 设置透明边框", () => {
    const { container } = render(<Tag bordered={false}>ok</Tag>);
    const tag = container.querySelector(".rui-tag") as HTMLElement;
    expect(tag.style.borderColor).toBe("transparent");
  });

  it("Badge status 模式渲染状态点与文案", () => {
    render(<Badge status="success" text="完成" />);
    expect(screen.getByText("完成")).toBeInTheDocument();
    expect(document.querySelector(".rui-badge-status-success")).not.toBeNull();
  });

  it("Badge count 超 overflowCount 显示 N+", () => {
    const { container } = render(<Badge count={200} overflowCount={99} />);
    expect(container.textContent).toContain("99+");
  });
});

describe("ui/primitives · Spin / Empty / Divider / Card", () => {
  it("Spin 渲染 loading 角色，large 注入 class", () => {
    const { container } = render(<Spin size="large" />);
    const span = container.querySelector(".rui-spin")!;
    expect(span.getAttribute("role")).toBe("status");
    expect(span.className).toContain("rui-spin-lg");
  });

  it("Empty 默认文案为「暂无数据」", () => {
    render(<Empty />);
    expect(screen.getByText("暂无数据")).toBeInTheDocument();
  });

  it("Card 渲染标题与内容体", () => {
    render(
      <Card title="统计" extra={<span>更多</span>}>
        内容
      </Card>,
    );
    expect(screen.getByText("统计")).toBeInTheDocument();
    expect(screen.getByText("更多")).toBeInTheDocument();
    expect(screen.getByText("内容")).toBeInTheDocument();
  });

  it("Divider 渲染分隔元素", () => {
    const { container } = render(<Divider />);
    expect(container.querySelector(".rui-divider")).toBeInTheDocument();
  });
});

describe("ui/primitives · Alert / Statistic", () => {
  it("Alert 按 type 渲染并支持 closable 回调", () => {
    const onClose = vi.fn();
    render(
      <Alert type="warning" message="注意" description="详情" closable onClose={onClose} />,
    );
    expect(screen.getByText("注意")).toBeInTheDocument();
    expect(document.querySelector(".rui-alert-warning")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Statistic 数字按 precision 格式化，prefix/suffix 透传", () => {
    render(
      <Statistic title="大小" value={3.14159} precision={2} prefix="$" suffix="MB" />,
    );
    expect(screen.getByText("大小")).toBeInTheDocument();
    expect(screen.getByText("$")).toBeInTheDocument();
    expect(screen.getByText("MB")).toBeInTheDocument();
    expect(screen.getByText("3.14")).toBeInTheDocument();
  });
});

describe("ui/primitives · Progress", () => {
  it("percent 钳制到 0..100", () => {
    const { container: over } = render(<Progress percent={150} />);
    expect(over.querySelector(".rui-progress")!.getAttribute("aria-valuenow")).toBe(
      "100",
    );
    const { container: under } = render(<Progress percent={-20} />);
    expect(under.querySelector(".rui-progress")!.getAttribute("aria-valuenow")).toBe(
      "0",
    );
  });

  it("success 状态注入对应 class，format 自定义文案", () => {
    const { container } = render(
      <Progress percent={50} status="success" format={(p) => `完成 ${p}%`} />,
    );
    expect(container.querySelector(".rui-progress-status-success")).not.toBeNull();
    expect(screen.getByText("完成 50%")).toBeInTheDocument();
  });
});

describe("ui/primitives · Switch", () => {
  it("非受控开关点击切换并回调", () => {
    const onChange = vi.fn();
    render(<Switch onChange={onChange} />);
    const btn = screen.getByRole("switch");
    expect(btn).toHaveAttribute("aria-checked", "false");
    fireEvent.click(btn);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("受控开关以 checked 为准，点击仍回调但不自切换", () => {
    const onChange = vi.fn();
    render(<Switch checked onChange={onChange} />);
    const btn = screen.getByRole("switch");
    expect(btn).toHaveAttribute("aria-checked", "true");
    fireEvent.click(btn);
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe("ui/primitives · Slider", () => {
  it("按 value 计算轨道百分比，渲染 range 输入", () => {
    const { container } = render(<Slider min={0} max={200} value={100} />);
    const track = container.querySelector(".rui-slider-track") as HTMLElement;
    expect(track.style.width).toBe("50%");
    expect(container.querySelector('input[type="range"]')).not.toBeNull();
  });
});

describe("ui/primitives · InputNumber", () => {
  it("空输入回调 null 且不抛错", () => {
    const onChange = vi.fn();
    render(<InputNumber value={5} min={1} max={60} onChange={onChange} />);
    const input = screen.getByDisplayValue("5") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("超出上界的输入被钳制", () => {
    const onChange = vi.fn();
    render(<InputNumber value={5} min={1} max={60} onChange={onChange} />);
    const input = screen.getByDisplayValue("5") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "999" } });
    expect(onChange).toHaveBeenCalledWith(60);
  });
});
