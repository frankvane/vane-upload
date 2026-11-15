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
import { createPortal } from "react-dom";
import { Button } from "./primitives";
import { registerEscapeHandler } from "./escapeStack";

/* ============================ Portal 工具 ============================ */

const canDOM = typeof document !== "undefined";

/** T-70：浮层默认挂载点提为模块级常量，避免每次渲染新建闭包。 */
const defaultGetPopupContainer = (): HTMLElement => document.body;

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** T-70：aria-modal 的面板必须把 Tab 圈禁在自身内，否则焦点会逃到背景内容。 */
const trapTabKey = (
  e: React.KeyboardEvent<HTMLElement>,
  container: HTMLElement | null,
): void => {
  if (e.key !== "Tab" || !container) return;
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  if (nodes.length === 0) {
    e.preventDefault();
    container.focus();
    return;
  }
  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === container)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
};

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
  const tooltipId = React.useId();

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

  // T-70：浮层可见时把 ESC 交给共享栈（只关最上层浮层），隐藏/卸载即注销。
  React.useEffect(() => {
    if (!visible) return;
    return registerEscapeHandler(() => hide());
  }, [visible, hide]);

  // a11y：aria-describedby 必须挂到「首个可聚焦元素」而非最外层包裹 div，
  // 否则屏幕阅读器聚焦 Switch/Input 等控件时不会播报提示（此前挂在 div 上被忽略）。
  // 可见时关联、隐藏/卸载时清除；优先取子元素自身，否则递归找首个 focusable 后代。
  React.useEffect(() => {
    const el = childRef.current;
    if (!el) return;
    const target =
      el.matches(FOCUSABLE_SELECTOR) ? el : el.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    if (!target) return;
    if (visible) {
      target.setAttribute("aria-describedby", tooltipId);
    } else {
      target.removeAttribute("aria-describedby");
    }
    return () => {
      target.removeAttribute("aria-describedby");
    };
  }, [visible, tooltipId]);

  if (!title) return children;

  const container = (getPopupContainer ?? defaultGetPopupContainer)();

  // T-70：保留子元素原有同名事件，不再用 cloneElement 直接覆盖。
  // 合并写成内联闭包：不把含 ref 的 show/hide 作为参数传给辅助函数，
  // 避免 react-hooks 判为「render 期读取 ref」。
  const childProps = children.props as React.HTMLAttributes<HTMLElement>;
  const onMouseEnter = (e: React.MouseEvent<HTMLElement>) => {
    childProps.onMouseEnter?.(e);
    show();
  };
  const onMouseLeave = (e: React.MouseEvent<HTMLElement>) => {
    childProps.onMouseLeave?.(e);
    hide();
  };
  const onFocus = (e: React.FocusEvent<HTMLElement>) => {
    childProps.onFocus?.(e);
    show();
  };
  const onBlur = (e: React.FocusEvent<HTMLElement>) => {
    childProps.onBlur?.(e);
    hide();
  };

  return (
    <>
      {React.cloneElement(children, {
        ref: childRef,
        onMouseEnter,
        onMouseLeave,
        onFocus,
        onBlur,
      } as Partial<React.HTMLAttributes<HTMLElement>>)}
      {canDOM &&
        visible &&
        pos &&
        createPortal(
          <div
            id={tooltipId}
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
  const popoverRef = React.useRef<HTMLDivElement | null>(null);

  const openAt = React.useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({ left: rect.left + rect.width / 2, top: rect.bottom + 6 });
    setOpen(true);
  }, []);

  // 触发器点击：按当前 open 切换开/合，而非只能打开。
  const handleTriggerClick = React.useCallback(() => {
    if (open) {
      setOpen(false);
    } else {
      openAt();
    }
  }, [open, openAt]);

  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".rui-popconfirm")) return;
      if (anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    // VU-44：ESC 走共享单例，mousedown 也声明 passive（不阻止默认行为）。
    document.addEventListener("mousedown", onDocClick, { passive: true });
    const unregisterEscape = registerEscapeHandler(() => setOpen(false));
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      unregisterEscape();
    };
  }, [open]);

  // a11y：打开时把焦点移入浮层首个按钮，并用 trapTabKey 圈禁 Tab，防焦点逃出。
  React.useEffect(() => {
    if (!open) return;
    const node = popoverRef.current;
    if (!node) return;
    node.querySelector<HTMLElement>("button")?.focus();
  }, [open]);

  // 仅字符串 title 可作 aria-label；复杂节点留给标题文本自身。
  const dialogAriaLabel = typeof title === "string" ? title : undefined;

  return (
    <>
      {React.cloneElement(children, {
        ref: anchorRef,
        onClick: handleTriggerClick,
      } as Partial<React.HTMLAttributes<HTMLElement>>)}
      {canDOM &&
        open &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            className="rui-popover rui-popconfirm"
            style={{ left: pos.left, top: pos.top, position: "fixed", transform: "translateX(-50%)" }}
            role="dialog"
            aria-label={dialogAriaLabel}
            aria-modal="false"
            onKeyDown={(e) => trapTabKey(e, popoverRef.current)}
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
  const dialogRef = React.useRef<HTMLDivElement>(null);
  // VU-30：回调经 ref 读取，避免 effect 捕获首次渲染的过期 onCancel。
  // VU-64：ref 镜像改在 effect 内更新（render 期写 ref 触发 react-hooks/refs）。
  const onCancelRef = React.useRef(onCancel);
  React.useEffect(() => {
    onCancelRef.current = onCancel;
  });

  React.useEffect(() => {
    // VU-30 + VU-44：监听只注册一次，回调经 ref 读取最新 onCancel；
    // ESC 派发交给共享单例（只作用于最上层浮层）。
    return registerEscapeHandler(() => onCancelRef.current?.());
  }, []);

  // T-70：打开时记下来源焦点并把焦点移入对话框，关闭（卸载）时归还。
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      const previous = restoreFocusRef.current;
      restoreFocusRef.current = null;
      previous?.focus?.();
    };
  }, []);

  // 尊重 open：关闭时不渲染弹层（此前忽略 open 导致弹层常驻，调用方无法隐藏）
  if (!open) return null;

  return createPortal(
    <>
      {/* mask 仅作视觉遮罩；wrap 与 mask 同 z-index 且后绘制会整屏覆盖 mask，
          故关闭点击放在 wrap 上，并以 target===currentTarget 判定「点到对话框之外」，
          与 antd 语义一致（点击对话框内部不关闭）。 */}
      <div className="rui-modal-mask" />
      <div
        className="rui-modal-wrap"
        onClick={(e) => {
          if (e.target === e.currentTarget) onCancel?.();
        }}
      >
        <div
          ref={dialogRef}
          className="rui-modal"
          style={{ width, ...style }}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          onKeyDown={(e) => trapTabKey(e, dialogRef.current)}
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
      open
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
  const panelRef = React.useRef<HTMLDivElement>(null);
  // VU-44：回调经 ref 读取，effect 依赖只保留 open，避免 onClose 变化反复注册监听。
  // VU-64：ref 镜像改在 effect 内更新。
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  });

  // T-70：打开时记下来源焦点并移入面板，关闭时归还；ESC 仍走共享栈。
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const unregisterEscape = registerEscapeHandler(() => onCloseRef.current?.());
    return () => {
      unregisterEscape();
      const previous = restoreFocusRef.current;
      restoreFocusRef.current = null;
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <>
      <div className="rui-drawer-mask" onClick={() => onClose?.()} />
      <div
        ref={panelRef}
        className={`rui-drawer rui-drawer-${placement}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={(e) => trapTabKey(e, panelRef.current)}
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
