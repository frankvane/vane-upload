import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { Col, Row, Typography } from "./typography";

describe("ui/typography · Text", () => {
  it("按 type/strong/ellipsis 拼 class", () => {
    const { container } = render(
      <Typography.Text type="danger" strong ellipsis>
        hi
      </Typography.Text>,
    );
    const span = container.querySelector("span")!;
    expect(span.className).toContain("rui-text-danger");
    expect(span.className).toContain("rui-text-strong");
    expect(span.className).toContain("rui-text-ellipsis");
  });

  it("无修饰时只有基础 class", () => {
    const { container } = render(<Typography.Text>x</Typography.Text>);
    const span = container.querySelector("span")!;
    expect(span.className).toBe("rui-text");
  });
});

describe("ui/typography · Paragraph / Title", () => {
  it("Paragraph 渲染为 p", () => {
    const { container } = render(<Typography.Paragraph>x</Typography.Paragraph>);
    expect(container.querySelector("p")).toBeInTheDocument();
  });

  it("Title 按 level 映射字号，自定义 style 不覆盖字号", () => {
    const { container } = render(
      <Typography.Title level={3} style={{ marginTop: 24 }}>
        T
      </Typography.Title>,
    );
    const h = container.querySelector("h1")!;
    expect(h.style.fontSize).toBe("20px");
    expect(h.style.marginTop).toBe("24px");
  });
});

describe("ui/typography · Row / Col", () => {
  it("gutter 转为行负边距与列内边距", () => {
    const { container } = render(
      <Row gutter={16}>
        <Col span={12}>a</Col>
      </Row>,
    );
    const row = container.querySelector(".rui-row") as HTMLElement;
    expect(row.style.marginLeft).toBe("-8px");
    expect(row.style.marginRight).toBe("-8px");

    const col = container.querySelector(".rui-col-12") as HTMLElement;
    expect(col.className).toContain("rui-col-12");
    expect(col.style.paddingLeft).toBe("8px");
  });

  it("无 gutter 时行无负边距", () => {
    const { container } = render(<Row>x</Row>);
    const row = container.querySelector(".rui-row") as HTMLElement;
    expect(row.style.marginLeft).toBe("");
  });
});
