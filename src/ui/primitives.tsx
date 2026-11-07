/**
 * rui-ui 原子组件（精减模式）。
 *
 * 只实现 src 内真实用到的 API 面——不追求 antd 全量兼容。
 * 每个组件的 props 都与调用点逐条对齐，多余特性一律不实现。
 */
import React from "react";

/* ============================ Button ============================ */

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  /** primary=实心主按钮；link=文字链接；text=无边框文字；默认=描边按钮 */
  type?: "primary" | "link" | "text" | "default";
  size?: "small" | "middle";
  danger?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  block?: boolean;
}

// forwardRef：Tooltip/Popconfirm 会通过 cloneElement 向子元素注入 ref，
// 函数组件必须显式转发才能落到原生 <button> 上（否则 React 报 ref 警告）。
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      type = "default",
      size = "middle",
      danger,
      loading,
      icon,
      block,
      children,
      className,
      disabled,
      onClick,
      ...rest
    },
    ref,
  ) => {
    const classes = [
      "rui-btn",
      size === "small" ? "rui-btn-sm" : "",
      type !== "default" ? `rui-btn-${type}` : "",
      danger && type !== "link" && type !== "text" ? "rui-btn-dangerous" : "",
      loading ? "rui-btn-loading" : "",
      block ? "rui-btn-block" : "",
      disabled || loading ? "rui-btn-disabled" : "",
      className || "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        ref={ref}
        type="button"
        className={classes}
        disabled={disabled || loading}
        onClick={onClick}
        {...rest}
      >
        {loading ? <span className="rui-spin rui-spin-sm" /> : icon}
        {children}
      </button>
    );
  },
);

Button.displayName = "Button";

/* ============================ Tag ============================ */

export type TagColor =
  | "blue"
  | "cyan"
  | "green"
  | "orange"
  | "red"
  | "default"
  | "processing"
  | "success"
  | "warning"
  | "error";

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** 预置色板；也容忍任意字符串（运行时未知色按 default 渲染） */
  color?: TagColor | (string & {});
  bordered?: boolean;
}

export const Tag: React.FC<TagProps> = ({
  color,
  bordered,
  className,
  children,
  style,
  ...rest
}) => (
  <span
    className={[
      "rui-tag",
      color ? `rui-tag-${color}` : "",
      className || "",
    ]
      .filter(Boolean)
      .join(" ")}
    style={bordered === false ? { ...style, borderColor: "transparent" } : style}
    {...rest}
  >
    {children}
  </span>
);

/* ============================ Badge ============================ */

export type BadgeStatus = "success" | "processing" | "default" | "error" | "warning";

export interface BadgeProps {
  /** 状态点模式：status + text */
  status?: BadgeStatus;
  text?: React.ReactNode;
  /** 计数模式：count */
  count?: number;
  /** 计数背景色（antd 风格允许覆盖） */
  style?: React.CSSProperties;
  /** 计数上限（超过显示 N+） */
  overflowCount?: number;
}

export const Badge: React.FC<BadgeProps> = ({
  status,
  text,
  count,
  style,
  overflowCount = 99,
}) => {
  if (status) {
    return (
      <span className={`rui-badge rui-badge-status-${status}`}>
        <span className="rui-badge-status-dot" />
        {text !== undefined && <span className="rui-badge-text">{text}</span>}
      </span>
    );
  }
  const display =
    count !== undefined && count > overflowCount
      ? `${overflowCount}+`
      : count;
  return (
    <span className="rui-badge">
      <span className="rui-badge-count" style={style}>
        {display}
      </span>
    </span>
  );
};

/* ============================ Spin ============================ */

export interface SpinProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: "small" | "default" | "large";
  /** 占满一行居中（loading 整页/整块时用） */
  block?: boolean;
}

export const Spin: React.FC<SpinProps> = ({
  size = "default",
  block,
  className,
  ...rest
}) => (
  <span
    className={[
      "rui-spin",
      size === "small" ? "rui-spin-sm" : size === "large" ? "rui-spin-lg" : "",
      block ? "rui-spin-block" : "",
      className || "",
    ]
      .filter(Boolean)
      .join(" ")}
    role="status"
    aria-label="loading"
    {...rest}
  />
);

/* ============================ Empty ============================ */

export const Empty: React.FC<{ description?: React.ReactNode }> = ({
  description,
}) => (
  <div className="rui-empty">
    <svg className="rui-empty-image" viewBox="0 0 64 41" aria-hidden="true">
      <g fill="none" fillRule="evenodd">
        <ellipse cx="32" cy="33" rx="32" ry="7" fill="#f5f5f5" />
        <path
          d="M55 12.76L44.85 1.2C44.367.474 43.656 0 42.907 0H21.093c-.749 0-1.46.474-1.945 1.2L9 12.76V22h46v-9.24z"
          fill="#fafafa"
        />
        <path
          d="M41.613 15.931c0-1.605.994-2.93 2.227-2.93H55v18.137c0 1.605-.994 2.946-2.227 2.946H11.227C9.994 34.084 9 32.743 9 31.139V13h11.16c1.233 0 2.227 1.325 2.227 2.931v.28c0 1.605.994 2.93 2.227 2.93h14.772c1.233 0 2.227-1.325 2.227-2.93v-.28z"
          fill="#e6e6e6"
        />
      </g>
    </svg>
    <span>{description ?? "暂无数据"}</span>
  </div>
);

/* ============================ Divider ============================ */

export const Divider: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...rest
}) => (
  <div
    className={["rui-divider", className || ""].filter(Boolean).join(" ")}
    role="separator"
    {...rest}
  />
);

/* ============================ Card ============================ */

export interface CardProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title?: React.ReactNode;
  extra?: React.ReactNode;
  size?: "small" | "default";
}

export const Card: React.FC<CardProps> = ({
  title,
  extra,
  size,
  className,
  children,
  ...rest
}) => (
  <div
    className={[
      "rui-card",
      size === "small" ? "rui-card-small" : "",
      className || "",
    ]
      .filter(Boolean)
      .join(" ")}
    {...rest}
  >
    {(title || extra) && (
      <div className="rui-card-head">
        <span>{title}</span>
        {extra && <span className="rui-card-extra">{extra}</span>}
      </div>
    )}
    <div className="rui-card-body">{children}</div>
  </div>
);

/* ============================ Space ============================ */

export interface SpaceProps extends React.HTMLAttributes<HTMLDivElement> {
  direction?: "horizontal" | "vertical";
  size?: "small" | "middle" | "large" | number;
  align?: "start" | "end" | "center" | "baseline";
  wrap?: boolean;
}

const GAP_MAP: Record<string, number> = { small: 8, middle: 16, large: 24 };

export const Space: React.FC<SpaceProps> = ({
  direction = "horizontal",
  size = "small",
  align,
  wrap,
  className,
  children,
  style,
  ...rest
}) => {
  const gap = typeof size === "number" ? size : GAP_MAP[size];
  const horizontal = direction === "horizontal";
  return (
    <div
      className={[
        "rui-space",
        horizontal ? "" : "rui-space-vertical",
        align ? `rui-space-align-${align}` : "",
        wrap ? "rui-space-wrap" : "",
        className || "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        gap,
        rowGap: wrap && horizontal ? 8 : undefined,
        ...style,
      }}
      {...rest}
    >
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(
              child as React.ReactElement<{ style?: React.CSSProperties }>,
              {
                style: {
                  ...(child.props as { style?: React.CSSProperties }).style,
                },
              },
            )
          : child,
      )}
    </div>
  );
};

/* ============================ Alert ============================ */

export interface AlertProps {
  type: "success" | "info" | "warning" | "error";
  message: React.ReactNode;
  description?: React.ReactNode;
  showIcon?: boolean;
  closable?: boolean;
  onClose?: () => void;
  style?: React.CSSProperties;
}

const ALERT_ICON: Record<AlertProps["type"], React.ReactNode> = {
  success: "✓",
  info: "i",
  warning: "!",
  error: "✕",
};

export const Alert: React.FC<AlertProps> = ({
  type,
  message,
  description,
  showIcon = true,
  closable,
  onClose,
  style,
}) => (
  <div className={`rui-alert rui-alert-${type}`} style={style} role="alert">
    {showIcon && (
      <span className="rui-alert-icon" aria-hidden="true">
        {ALERT_ICON[type]}
      </span>
    )}
    <div className="rui-alert-message">
      <div>{message}</div>
      {description && <div style={{ marginTop: 4 }}>{description}</div>}
    </div>
    {closable && (
      <button
        type="button"
        className="rui-modal-close"
        onClick={onClose}
        aria-label="close"
      >
        ✕
      </button>
    )}
  </div>
);

/* ============================ Statistic ============================ */

export interface StatisticProps {
  title?: React.ReactNode;
  value?: React.ReactNode;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  valueStyle?: React.CSSProperties;
  precision?: number;
  style?: React.CSSProperties;
}

export const Statistic: React.FC<StatisticProps> = ({
  title,
  value,
  prefix,
  suffix,
  valueStyle,
  precision,
  style,
}) => {
  const display =
    typeof value === "number" && precision !== undefined
      ? value.toFixed(precision)
      : value;
  return (
    <div className="rui-statistic" style={style}>
      {title !== undefined && <div className="rui-statistic-title">{title}</div>}
      <div className="rui-statistic-content" style={valueStyle}>
        {prefix && <span className="rui-statistic-prefix">{prefix}</span>}
        <span className="rui-statistic-value">{display}</span>
        {suffix && <span className="rui-statistic-suffix">{suffix}</span>}
      </div>
    </div>
  );
};

/* ============================ Progress ============================ */

export interface ProgressProps {
  percent: number;
  size?: "small" | "default";
  status?: "normal" | "success" | "exception" | "active";
  strokeColor?: string;
  showInfo?: boolean;
  /** 自定义右侧文案（对齐 antd format） */
  format?: (percent: number) => React.ReactNode;
  style?: React.CSSProperties;
}

export const Progress: React.FC<ProgressProps> = ({
  percent,
  size,
  status = "normal",
  strokeColor,
  showInfo = true,
  format,
  style,
}) => {
  const clamped = Math.max(0, Math.min(100, percent));
  const statusClass =
    status === "success"
      ? "rui-progress-status-success"
      : status === "exception"
        ? "rui-progress-status-exception"
        : "";
  return (
    <div
      className={[
        "rui-progress",
        size === "small" ? "rui-progress-small" : "",
        statusClass,
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="rui-progress-rail">
        <div
          className="rui-progress-inner"
          style={{ width: `${clamped}%`, background: strokeColor }}
        />
      </div>
      {showInfo && (
        <span className="rui-progress-text">
          {format
            ? format(clamped)
            : status === "success"
              ? "100%"
              : `${Math.round(clamped)}%`}
        </span>
      )}
    </div>
  );
};

/* ============================ Switch ============================ */

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  checkedChildren?: React.ReactNode;
  unCheckedChildren?: React.ReactNode;
  /** small：28×16 迷你开关（设置行内嵌场景）；default：44×22 */
  size?: "small" | "default";
  onChange?: (checked: boolean) => void;
  style?: React.CSSProperties;
}

// forwardRef：同 Button，Tooltip 场景需要把 ref 落到原生 <button>
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  (
    {
      checked,
      defaultChecked,
      disabled,
      checkedChildren,
      unCheckedChildren,
      size,
      onChange,
      style,
    },
    ref,
  ) => {
    const [inner, setInner] = React.useState(defaultChecked ?? false);
    const isControlled = checked !== undefined;
    const value = isControlled ? checked : inner;
    const hasText = Boolean(checkedChildren || unCheckedChildren);
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={value}
        disabled={disabled}
        className={[
          "rui-switch",
          value ? "rui-switch-checked" : "",
          size === "small" ? "rui-switch-sm" : "",
          hasText ? "rui-switch-has-text" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={style}
        onClick={() => {
          if (!isControlled) setInner(!value);
          onChange?.(!value);
        }}
      >
        {checkedChildren && value && (
          <span className="rui-switch-text rui-switch-text-inner">
            {checkedChildren}
          </span>
        )}
        {unCheckedChildren && !value && (
          <span className="rui-switch-text rui-switch-text-unchecked">
            {unCheckedChildren}
          </span>
        )}
      </button>
    );
  },
);

Switch.displayName = "Switch";

/* ============================ Slider ============================ */

export interface SliderProps {
  min?: number;
  max?: number;
  step?: number;
  value?: number;
  disabled?: boolean;
  /** 刻度标记：值 → 文案 */
  marks?: Record<number, string>;
  onChange?: (value: number) => void;
  style?: React.CSSProperties;
}

export const Slider: React.FC<SliderProps> = ({
  min = 0,
  max = 100,
  step = 1,
  value = 0,
  disabled,
  marks,
  onChange,
  style,
}) => {
  const pct = ((value - min) / (max - min)) * 100;
  const markEntries = marks ? Object.entries(marks) : [];
  return (
    <div className="rui-slider" style={style}>
      <div className="rui-slider-rail">
        <div className="rui-slider-track" style={{ width: `${pct}%` }} />
        <div className="rui-slider-handle" style={{ left: `${pct}%` }} />
        <input
          className="rui-slider-input"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange?.(Number(e.target.value))}
          aria-label="slider"
        />
      </div>
      {markEntries.length > 0 && (
        <div className="rui-slider-marks">
          {markEntries.map(([key, label]) => (
            <span
              key={key}
              className="rui-slider-mark"
              style={{ left: `${((Number(key) - min) / (max - min)) * 100}%` }}
            >
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

/* ============================ InputNumber ============================ */

export interface InputNumberProps {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  placeholder?: string;
  /** 后缀标签（如 "KB"） */
  addonAfter?: React.ReactNode;
  size?: "small" | "middle";
  style?: React.CSSProperties;
  onChange?: (value: number | null) => void;
}

export const InputNumber: React.FC<InputNumberProps> = ({
  value,
  min,
  max,
  step = 1,
  disabled,
  placeholder,
  addonAfter,
  size,
  style,
  onChange,
}) => {
  const [inner, setInner] = React.useState<string>(
    value !== undefined ? String(value) : "",
  );
  const display = value !== undefined ? String(value) : inner;
  const input = (
    <input
      className={[
        "rui-input-number",
        size === "small" ? "rui-input-number-sm" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      inputMode="numeric"
      disabled={disabled}
      placeholder={placeholder}
      value={display}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") {
          setInner("");
          onChange?.(null);
          return;
        }
        const n = Number(raw);
        if (Number.isNaN(n)) return;
        setInner(raw);
        let clamped = n;
        if (min !== undefined) clamped = Math.max(min, clamped);
        if (max !== undefined) clamped = Math.min(max, clamped);
        onChange?.(clamped);
      }}
      onBlur={(e) => {
        if (step && e.target.value !== "") {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) {
            const snapped = Math.round(n / step) * step;
            const clamped =
              min !== undefined ? Math.max(min, snapped) : snapped;
            setInner(String(clamped));
          }
        }
      }}
    />
  );
  if (addonAfter === undefined) return input;
  return (
    <span
      className={[
        "rui-input-number-group",
        size === "small" ? "rui-input-number-group-sm" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {input}
      <span className="rui-input-number-addon">{addonAfter}</span>
    </span>
  );
};
