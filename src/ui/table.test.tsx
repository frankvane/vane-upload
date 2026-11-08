import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Table } from "./table";

describe("VU-41 Table 长列表渲染", () => {
  it("每一行启用 content-visibility 与 intrinsic size", () => {
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
      const style = row.getAttribute("style") ?? "";
      expect(style).toContain("content-visibility");
      expect(style).toContain("contain-intrinsic-size");
    }
  });
});
