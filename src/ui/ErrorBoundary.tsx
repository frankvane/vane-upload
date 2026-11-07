import React from "react";
import { Alert, Button, Space } from "./primitives";

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** 兜底标题，默认"组件加载失败" */
  fallbackTitle?: string;
  /** 自定义兜底渲染（替代默认 Alert + 刷新按钮） */
  fallbackRender?: (error: Error, reset: () => void) => React.ReactNode;
  /** 自定义"刷新 / 重载资源"行为；不传则默认 window.location.reload() */
  onReload?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

/**
 * 顶层错误边界（F6）：避免 Worker 资源 404 / 网络抖动 / 渲染期异常导致整页白屏。
 *
 * 旧 chunk 404（发版后用户停留在旧页面）或任意渲染期抛错会被此处捕获，
 * 展示"刷新 / 重载资源"兜底，而非整页白屏。消费方可传入 fallbackRender 自定义。
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 真实失败始终记录到控制台（不受 debug silent 控制）
    console.error("[rui-upload] 组件渲染异常被 ErrorBoundary 捕获:", error, info);
  }

  handleReload = (): void => {
    if (this.props.onReload) {
      this.props.onReload();
      return;
    }
    if (typeof window !== "undefined" && window.location) {
      window.location.reload();
    }
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallbackRender && this.state.error) {
      return this.props.fallbackRender(this.state.error, this.handleReload);
    }

    return (
      <div>
        <Alert
          type="error"
          message={this.props.fallbackTitle ?? "组件加载失败"}
          description={
            this.state.error?.message ??
            "渲染过程中发生未知错误，可能是资源加载失败或脚本错误。"
          }
        />
        <Space direction="vertical" style={{ marginTop: 12 }}>
          <Button onClick={this.handleReload}>刷新页面 / 重载资源</Button>
        </Space>
      </div>
    );
  }
}
