import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

/**
 * F6：顶层错误边界。
 * 验证：渲染期抛错被捕获并渲染兜底（标题 + 描述 + 刷新按钮），
 * 自定义 fallbackRender 生效，正常子节点不受干扰，刷新按钮触发 reload。
 */

// 渲染即抛错的子组件
const Boom = (): JSX.Element => {
  throw new Error("boom on render");
};

describe("ErrorBoundary（F6：顶层错误边界）", () => {
  it("渲染期异常被捕获并展示默认兜底（标题 + 描述 + 刷新按钮）", () => {
    render(
      <ErrorBoundary fallbackTitle="上传组件加载失败">
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText("上传组件加载失败")).toBeInTheDocument();
    expect(screen.getByText(/boom on render/)).toBeInTheDocument();
    expect(
      screen.getByText(/刷新页面 \/ 重载资源/)
    ).toBeInTheDocument();
  });

  it("刷新按钮触发 reload（默认 window.location.reload，可经 onReload 自定义）", () => {
    const reloadSpy = vi.fn();
    render(
      <ErrorBoundary onReload={reloadSpy}>
        <Boom />
      </ErrorBoundary>
    );
    fireEvent.click(screen.getByText(/刷新页面 \/ 重载资源/));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("自定义 fallbackRender 替代默认兜底", () => {
    const Custom = (error: Error): JSX.Element => (
      <div data-testid="custom">custom: {error.message}</div>
    );
    render(
      <ErrorBoundary fallbackRender={Custom}>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByTestId("custom")).toHaveTextContent("boom on render");
  });

  it("正常子节点渲染不受错误边界影响", () => {
    render(
      <ErrorBoundary>
        <div>ok content</div>
      </ErrorBoundary>
    );
    expect(screen.getByText("ok content")).toBeInTheDocument();
  });
});
