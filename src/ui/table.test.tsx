import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Table } from "./table";

describe("VU-41 Table 长列表渲染", () => {
  it("content-visibility 优化统一由 ui.css 声明，行内不再重复内联（T-72 去重）", () => {
    const { container } = render(
      <Table
        columns={[{ title: "文件名", dataIndex: "name", key: "name" }]}
        dataSource={[
          { key: "a", name: "a.bin" },
          { key: "b", name: "b.bin" },
        ]}
      />
    );

    const rows = container.querySelectorAll("tr.rui-table-row");
    expect(rows).toHaveLength(2);
    for (const row of Array.from(rows)) {
      // T-72：屏外行跳过布局/绘制的优化统一在 ui.css `.rui-table tbody tr.rui-table-row`
      // 声明（含 Firefox/Safari 降级注释），行内不再内联重复定义，
      // 避免 48px 与 CSS 44px 两套口径互相打架。
      const style = row.getAttribute("style") ?? "";
      expect(style).not.toContain("content-visibility");
      expect(style).not.toContain("contain-intrinsic-size");
    }
  });
});
