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

  it("T-77 Badge count=0 不渲染孤立的 0", () => {
    const { container } = render(<Badge count={0} />);
    expect(container.firstChild).toBeNull();
    expect(container.textContent).not.toContain("0");
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

  it("T-77 Statistic 数字带千分位，precision 仍控制小数位", () => {
    // 用运行时 locale 生成期望文案，避免把 CI 的 en-US 分组符写死；
    // 但断言「确实有分组」以防该 locale 恰好无分组时用例恒真。
    const grouped = (1234567).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 20,
    });
    expect(grouped).not.toBe("1234567");

    const { rerender } = render(<Statistic value={1234567} />);
    expect(screen.getByText(grouped)).toBeInTheDocument();

    const withPrecision = (1234567.891).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    rerender(<Statistic value={1234567.891} precision={2} />);
    expect(screen.getByText(withPrecision)).toBeInTheDocument();
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

  it("inner 用 transform: scaleX 驱动而非 width（避免高频重排）", () => {
    const { container } = render(<Progress percent={40} />);
    const inner = container.querySelector(".rui-progress-inner") as HTMLElement;
    // 填充由 scaleX 表达，不再用内联 width 驱动 -> 进度高频变化只触发合成层、不触发 layout
    expect(inner.style.transform).toMatch(/scaleX\(0?\.4\)/);
    expect(inner.style.width).not.toBe("40%");
  });

  it("percent 为 NaN 时钳为 0，不把 NaN 落 DOM / aria-valuenow（T-72）", () => {
    const { container } = render(<Progress percent={Number.NaN} />);
    const bar = container.querySelector(".rui-progress") as HTMLElement;
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    const inner = container.querySelector(".rui-progress-inner") as HTMLElement;
    // scaleX(NaN) 会让合成层失效并出现渲染异常，必须钳 0
    expect(inner.style.transform).toBe("scaleX(0)");
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

  it.each([
    ["max===min 且 value 在区间内", 0, 0, 0],
    ["max===min 且 value 越界（仍不除零）", 5, 5, 5],
  ])("Slider %s 时不产生 Infinity/NaN（T-72）", (_label, min, max, value) => {
    const { container } = render(<Slider min={min} max={max} value={value} />);
    const track = container.querySelector(".rui-slider-track") as HTMLElement;
    const handle = container.querySelector(".rui-slider-handle") as HTMLElement;
    // max===min 分母为 0 时退化为 0%，轨道/手柄不越界
    expect(track.style.width).toBe("0%");
    expect(handle.style.left).toBe("0%");
    expect(track.style.width).not.toMatch(/Infinity|NaN/);
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
