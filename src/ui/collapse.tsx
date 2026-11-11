/**
 * rui-ui Collapse（精减模式）——仅 items API + small/ghost。
 */
import React from "react";

export interface CollapseItem {
  key: string;
  label: React.ReactNode;
  children: React.ReactNode;
  /** 禁用项 */
  disabled?: boolean;
}

export interface CollapseProps {
  items: CollapseItem[];
  size?: "small" | "middle";
  ghost?: boolean;
  defaultActiveKey?: string[];
  activeKey?: string[];
  onChange?: (keys: string[]) => void;
  style?: React.CSSProperties;
}

export const Collapse: React.FC<CollapseProps> = ({
  items,
  size,
  ghost,
  defaultActiveKey,
  activeKey,
  onChange,
  style,
}) => {
  const [innerKeys, setInnerKeys] = React.useState<string[]>(
    defaultActiveKey ?? [],
  );
  const keys = activeKey ?? innerKeys;
  // T-72：展开项通常少量，includes 无所谓性能；统一转 Set 保持口径一致。
  const keySet = new Set(keys);

  const toggle = (key: string) => {
    const next = keySet.has(key)
      ? keys.filter((k) => k !== key)
      : [...keys, key];
    if (!activeKey) setInnerKeys(next);
    onChange?.(next);
  };

  return (
    <div
      className={[
        "rui-collapse",
        size === "small" ? "rui-collapse-small" : "",
        ghost ? "rui-collapse-ghost" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
    >
      {items.map((item) => {
        const active = keySet.has(item.key);
        return (
          <div
            key={item.key}
            className={`rui-collapse-item${active ? " rui-collapse-item-active" : ""}`}
          >
            <div
              className="rui-collapse-header"
              role="button"
              tabIndex={item.disabled ? -1 : 0}
              aria-expanded={active}
              aria-disabled={item.disabled}
              style={item.disabled ? { cursor: "not-allowed", opacity: 0.5 } : undefined}
              onClick={() => !item.disabled && toggle(item.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (!item.disabled) toggle(item.key);
                }
              }}
            >
              <span>{item.label}</span>
              <span className="rui-collapse-arrow" aria-hidden="true">
                ▶
              </span>
            </div>
            {active && (
              <div className="rui-collapse-content">{item.children}</div>
            )}
          </div>
        );
      })}
    </div>
  );
};
