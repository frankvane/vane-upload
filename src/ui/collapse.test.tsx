import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { Collapse, type CollapseItem } from "./collapse";

const items: CollapseItem[] = [
  { key: "a", label: "第一项", children: "内容A" },
  { key: "b", label: "第二项", children: "内容B" },
];

describe("ui/collapse", () => {
  it("默认全部折叠，激活项才展开内容", () => {
    const { container } = render(<Collapse items={items} />);
    expect(screen.queryByText("内容A")).toBeNull();
    const header = screen.getByText("第一项");
    fireEvent.click(header);
    expect(screen.getByText("内容A")).toBeInTheDocument();
    expect(container.querySelector(".rui-collapse-item-active")).not.toBeNull();
  });

  it("受控模式以 activeKey 为准，点击经 onChange 回调", () => {
    const onChange = vi.fn();
    render(<Collapse items={items} activeKey={["a"]} onChange={onChange} />);
    expect(screen.getByText("内容A")).toBeInTheDocument();
    fireEvent.click(screen.getByText("第一项"));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("disabled 项不可点击展开", () => {
    render(
      <Collapse
        items={[{ key: "x", label: "禁项", children: "禁内容", disabled: true }]}
      />,
    );
    fireEvent.click(screen.getByText("禁项"));
    expect(screen.queryByText("禁内容")).toBeNull();
  });

  it("键盘 Enter / 空格可切换", () => {
    render(<Collapse items={items} />);
    const header = screen.getByText("第二项");
    fireEvent.keyDown(header, { key: "Enter" });
    expect(screen.getByText("内容B")).toBeInTheDocument();
    fireEvent.keyDown(header, { key: " " });
    expect(screen.queryByText("内容B")).toBeNull();
  });

  it("size=small / ghost 注入对应 class", () => {
    const { container } = render(<Collapse items={items} size="small" ghost />);
    expect(container.querySelector(".rui-collapse-small")).not.toBeNull();
    expect(container.querySelector(".rui-collapse-ghost")).not.toBeNull();
  });
});
