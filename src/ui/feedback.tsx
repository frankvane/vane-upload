/**
 * rui-ui 浮层组件（精减模式）：Tooltip / Popconfirm / Modal / Drawer。
 *
 * 只实现调用点用到的能力：
 * - Tooltip: title（字符串，纯 hover 提示，无浮层内容/受控模式）
 * - Modal: title/open/onCancel/onOk/footer/width + 命令式 Modal.confirm
 * - Drawer: title/open/onClose/placement/width（右侧为主，含焦点圈禁与 ESC）
 */
import React from "react";
import { createRoot } from "react-dom/client";
import ReactDOM from "react-dom";
import { Button } from "./primitives";

/* ============================ Portal 工具 ============================ */

const canDOM = typeof document !== "undefined";

/* ============================ Tooltip ============================ */

export interface TooltipProps {
  title: React.ReactNode;
  children: React.ReactElement;
  /** 位置暂仅支持 top/bottom（调用点只用这两者） */
  placement?: "top" | "bottom";
  /** 浮层挂载容器（对齐 antd；默认 document.body） */
  getPopupContainer?: () => HTMLElement;
}

export const Tooltip: React.FC<TooltipProps> = ({
  title,
  children,
  placement = "top",
  getPopupContainer,
}) => {
  const [visible, setVisible] = React.useState(false);
  const [pos, setPos] = React.useState<{
    left: number;
    top: number;
    arrowTop: number;
  } | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const childRef = React.useRef<HTMLElement | null>(null);

  const show = React.useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const el = childRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setVisible(true);
      setPos({
        left: rect.left + rect.width / 2,
        top: placement === "top" ? rect.top - 8 : rect.bottom + 8,
        arrowTop: placement === "top" ? rect.top - 8 : rect.bottom + 8,
      });
    }, 150);
  }, [placement]);

  const hide = React.useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setVisible(false);
  }, []);

  React.useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  if (!title) return children;

  const container = getPopupContainer?.() ?? document.body;

  return (
    <>
      {React.cloneElement(children, {
        ref: childRef,
        onMouseEnter: show,
        onMouseLeave: hide,
        onFocus: show,
        onBlur: hide,
      } as Partial<React.HTMLAttributes<HTMLElement>>)}
      {canDOM &&
        visible &&
        pos &&
        ReactDOM.createPortal(
          <div
            className="rui-tooltip"
            style={{
              left: pos.left,
              top: pos.top,
              transform:
                placement === "top"
                  ? "translate(-50%, -100%)"
                  : "translate(-50%, 0)",
            }}
            role="tooltip"
          >
            {title}
            <span
              className="rui-tooltip-arrow"
              style={{
                left: 4,
                top: placement === "top" ? pos.arrowTop - pos.top - 3 : -4,
              }}
            />
          </div>,
          container,
        )}
    </>
  );
};

/* ============================ Popconfirm ============================ */

export interface PopconfirmProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  okText?: string;
  cancelText?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
  children: React.ReactElement;
}

export const Popconfirm: React.FC<PopconfirmProps> = ({
  title,
  description,
  okText = "确定",
  cancelText = "取消",
  onConfirm,
  onCancel,
  children,
}) => {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(
    null,
  );
  const anchorRef = React.useRef<HTMLElement | null>(null);

  const openAt = React.useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({ left: rect.left + rect.width / 2, top: rect.bottom + 6 });
    setOpen(true);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".rui-popconfirm")) return;
      if (anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      {React.cloneElement(children, {
        ref: anchorRef,
        onClick: openAt,
      } as Partial<React.HTMLAttributes<HTMLElement>>)}
      {canDOM &&
        open &&
        pos &&
        ReactDOM.createPortal(
          <div
            className="rui-popover rui-popconfirm"
            style={{ left: pos.left, top: pos.top, position: "fixed", transform: "translateX(-50%)" }}
            role="dialog"
          >
            <div className="rui-popconfirm-title">
              <span style={{ color: "#faad14" }} aria-hidden="true">
                !
              </span>
              <span>{title}</span>
            </div>
            {description && <div>{description}</div>}
            <div className="rui-popconfirm-buttons">
              <Button
                size="small"
                onClick={() => {
                  setOpen(false);
                  onCancel?.();
                }}
              >
                {cancelText}
              </Button>
              <Button
                size="small"
                type="primary"
                danger
                onClick={() => {
                  setOpen(false);
                  onConfirm?.();
                }}
              >
                {okText}
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};

/* ============================ Modal ============================ */

export interface ModalProps {
  title?: React.ReactNode;
  open?: boolean;
  onOk?: () => void;
  onCancel?: () => void;
  okText?: string;
  cancelText?: string;
  confirmLoading?: boolean;
  /** 直接传入按钮节点；不传则默认「取消 + 确定」 */
  footer?: React.ReactNode;
  width?: number;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

const ModalInner: React.FC<ModalProps> = ({
  title,
  open,
  onOk,
  onCancel,
  okText = "确定",
  cancelText = "取消",
  confirmLoading,
  footer,
  width = 520,
  children,
  style,
}) => {
  const [mounted, setMounted] = React.useState(false);
  const dialogRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setMounted(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    dialogRef.current?.focus();
  }, [mounted]);

  // 尊重 open：关闭时不渲染弹层（此前忽略 open 导致弹层常驻，调用方无法隐藏）
  if (!open) return null;
  if (!mounted) return null;

  return ReactDOM.createPortal(
    <>
      <div className="rui-modal-mask" onClick={() => onCancel?.()} />
      <div className="rui-modal-wrap">
        <div
          ref={dialogRef}
          className="rui-modal"
          style={{ width, ...style }}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
        >
          {title !== undefined && (
            <div className="rui-modal-header">
              <span>{title}</span>
              <button
                type="button"
                className="rui-modal-close"
                onClick={() => onCancel?.()}
                aria-label="close"
              >
                ✕
              </button>
            </div>
          )}
          <div className="rui-modal-body">{children}</div>
          {footer !== null && (
            <div className="rui-modal-footer">
              {footer ?? (
                <>
                  <Button onClick={() => onCancel?.()}>{cancelText}</Button>
                  <Button
                    type="primary"
                    loading={confirmLoading}
                    onClick={() => onOk?.()}
                  >
                    {okText}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
};

export interface ConfirmOptions {
  title: React.ReactNode;
  content?: React.ReactNode;
  okText?: string;
  cancelText?: string;
  okType?: "primary" | "danger";
  onOk?: () => void | Promise<void>;
  onCancel?: () => void;
}

/** 命令式确认框（对齐 antd Modal.confirm 调用面） */
// eslint-disable-next-line react-refresh/only-export-components
export const confirm = (options: ConfirmOptions) => {
  if (!canDOM) return;
  const holder = document.createElement("div");
  document.body.appendChild(holder);
  const root = createRoot(holder);

  const close = () => {
    root.unmount();
    holder.remove();
  };

  const handleOk = () => {
    const result = options.onOk?.();
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).then(close, close);
    } else {
      close();
    }
  };

  root.render(
    <Modal
      title={options.title}
      onCancel={() => {
        options.onCancel?.();
        close();
      }}
      okText={options.okText ?? "确定"}
      cancelText={options.cancelText ?? "取消"}
      footer={
        <>
          <Button
            onClick={() => {
              options.onCancel?.();
              close();
            }}
          >
            {options.cancelText ?? "取消"}
          </Button>
          <Button
            type="primary"
            danger={options.okType === "danger"}
            onClick={handleOk}
          >
            {options.okText ?? "确定"}
          </Button>
        </>
      }
    >
      {options.content}
    </Modal>,
  );
};

/**
 * Modal：open 控制显隐；confirm 以静态方法挂载（对齐 antd Modal.confirm）。
 * 注意：confirm 必须先于本定义（TDZ），故置于上方。
 */
export const Modal: React.FC<ModalProps> & {
  confirm: (options: ConfirmOptions) => void;
} = Object.assign((props: ModalProps) => {
  if (!props.open) return null;
  return <ModalInner {...props} />;
}, { confirm });

/* ============================ Drawer ============================ */

export interface DrawerProps {
  title?: React.ReactNode;
  open?: boolean;
  onClose?: () => void;
  placement?: "right" | "left";
  width?: number;
  extra?: React.ReactNode;
  children?: React.ReactNode;
}

export const Drawer: React.FC<DrawerProps> = ({
  title,
  open,
  onClose,
  placement = "right",
  width = 378,
  extra,
  children,
}) => {
  const [mounted, setMounted] = React.useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => setMounted(true), []);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !mounted) return null;

  return ReactDOM.createPortal(
    <>
      <div className="rui-drawer-mask" onClick={() => onClose?.()} />
      <div
        ref={panelRef}
        className={`rui-drawer rui-drawer-${placement}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        {title !== undefined && (
          <div className="rui-drawer-header">
            <span>{title}</span>
            <span className="rui-drawer-header-extra" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {extra}
              <button
                type="button"
                className="rui-modal-close"
                onClick={() => onClose?.()}
                aria-label="close"
              >
                ✕
              </button>
            </span>
          </div>
        )}
        <div className="rui-drawer-body">{children}</div>
      </div>
    </>,
    document.body,
  );
};
