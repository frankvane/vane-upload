import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";

import { message } from "./message";

describe("ui/message", () => {
  afterEach(() => {
    message.destroy();
    cleanup();
  });

  it("success / error / warning / info 渲染对应类型 notice", async () => {
    message.success("保存成功");
    expect(await screen.findByText("保存成功")).toBeInTheDocument();
    expect(document.querySelector(".rui-message-success")).not.toBeNull();

    message.error("出错了");
    expect(await screen.findByText("出错了")).toBeInTheDocument();
    expect(document.querySelector(".rui-message-error")).not.toBeNull();

    message.warning("警告");
    expect(await screen.findByText("警告")).toBeInTheDocument();
    expect(document.querySelector(".rui-message-warning")).not.toBeNull();

    message.info("提示");
    expect(await screen.findByText("提示")).toBeInTheDocument();
    expect(document.querySelector(".rui-message-info")).not.toBeNull();
  });

  it("destroy 清空所有 notice", async () => {
    message.success("a");
    message.error("b");
    expect(await screen.findByText("a")).toBeInTheDocument();
    expect(await screen.findByText("b")).toBeInTheDocument();
    message.destroy();
    expect(screen.queryByText("a")).toBeNull();
    expect(screen.queryByText("b")).toBeNull();
    expect(document.querySelector(".rui-message")).toBeNull();
  });

  it("调用不抛错（DOM 环境下正常挂载）", () => {
    expect(() => message.info("noop")).not.toThrow();
  });
});
