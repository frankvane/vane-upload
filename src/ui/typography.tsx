/**
 * rui-ui Typography / Layout（精减模式）。
 */
import React from "react";

/* ============================ Typography ============================ */

export interface TextProps extends React.HTMLAttributes<HTMLSpanElement> {
  type?: "secondary" | "success" | "warning" | "danger" | "disabled";
  strong?: boolean;
  ellipsis?: boolean;
  /** ellipsis 时悬停展示全文本（原生 title 行为一致） */
  title?: string;
}

const Text: React.FC<TextProps> = ({
  type,
  strong,
  ellipsis,
  className,
  children,
  ...rest
}) => (
  <span
    className={[
      "rui-text",
      type ? `rui-text-${type}` : "",
      strong ? "rui-text-strong" : "",
      ellipsis ? "rui-text-ellipsis" : "",
      className || "",
    ]
      .filter(Boolean)
      .join(" ")}
    {...rest}
  >
    {children}
  </span>
);

const Paragraph: React.FC<React.HTMLAttributes<HTMLParagraphElement>> = ({
  className,
  children,
  ...rest
}) => (
  <p className={["rui-text", className || ""].filter(Boolean).join(" ")} {...rest}>
    {children}
  </p>
);

const Title: React.FC<
  React.HTMLAttributes<HTMLHeadingElement> & { level?: 1 | 2 | 3 | 4 | 5 }
> = ({ level = 1, className, children, style, ...rest }) => {
  const size = [28, 24, 20, 18, 16][level - 1];
  return (
    <h1
      className={["rui-text", className || ""].filter(Boolean).join(" ")}
      // style 必须放在内部默认值之后合并：此前 {...rest} 在内部 style 之后展开，
      // 传入 style={{marginTop:24}} 会整体覆盖，导致字号/去边距丢失（h1 回退 2em）。
      style={{
        fontSize: size,
        fontWeight: 600,
        margin: "0 0 12px",
        ...style,
      }}
      {...rest}
    >
      {children}
    </h1>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const Typography = { Text, Paragraph, Title };

/* ============================ Row / Col ============================ */

export interface RowProps extends React.HTMLAttributes<HTMLDivElement> {
  gutter?: number;
}

export const Row: React.FC<RowProps> = ({
  gutter = 0,
  className,
  children,
  style,
  ...rest
}) => {
  const gapStyle: React.CSSProperties = gutter
    ? { marginLeft: -gutter / 2, marginRight: -gutter / 2 }
    : {};
  return (
    <div
      className={["rui-row", className || ""].filter(Boolean).join(" ")}
      style={{ ...gapStyle, ...style }}
      {...rest}
    >
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(
              child as React.ReactElement<{ gutter?: number }>,
              { gutter },
            )
          : child,
      )}
    </div>
  );
};

export interface ColProps extends React.HTMLAttributes<HTMLDivElement> {
  span?: number;
  gutter?: number;
}

export const Col: React.FC<ColProps> = ({
  span = 24,
  gutter,
  className,
  children,
  style,
  ...rest
}) => (
  <div
    className={["rui-col", `rui-col-${span}`, className || ""]
      .filter(Boolean)
      .join(" ")}
    style={
      gutter
        ? { paddingLeft: gutter / 2, paddingRight: gutter / 2, ...style }
        : style
    }
    {...rest}
  >
    {children}
  </div>
);
