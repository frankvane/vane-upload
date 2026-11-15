import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";

import { createLeveledMessageApi, message, type MessageInstance } from "./message";

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

  it("同屏最多保留 3 条，超出淘汰最早一条", async () => {
    message.info("第一条");
    message.info("第二条");
    message.info("第三条");
    message.info("第四条");
    await waitFor(() => {
      expect(document.querySelectorAll(".rui-message-notice")).toHaveLength(3);
    });
    expect(screen.queryByText("第一条")).toBeNull();
    expect(screen.queryByText("第二条")).not.toBeNull();
    expect(screen.queryByText("第四条")).not.toBeNull();
  });
});

describe("createLeveledMessageApi", () => {
  const makeBase = () => {
    const base: MessageInstance = {
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    };
    return base;
  };

  it("默认 / all：四类全部放行", () => {
    for (const level of [undefined, "all"] as const) {
      const base = makeBase();
      const api = createLeveledMessageApi(base, level);
      api.success("s");
      api.error("e");
      api.warning("w");
      api.info("i");
      expect(base.success).toHaveBeenCalledTimes(1);
      expect(base.error).toHaveBeenCalledTimes(1);
      expect(base.warning).toHaveBeenCalledTimes(1);
      expect(base.info).toHaveBeenCalledTimes(1);
    }
  });

  it("warning-error：仅放行 error / warning，success / info 静默", () => {
    const base = makeBase();
    const api = createLeveledMessageApi(base, "warning-error");
    api.success("s");
    api.info("i");
    api.error("e");
    api.warning("w");
    expect(base.success).not.toHaveBeenCalled();
    expect(base.info).not.toHaveBeenCalled();
    expect(base.error).toHaveBeenCalledWith("e");
    expect(base.warning).toHaveBeenCalledWith("w");
  });

  it("none：四类全部静默", () => {
    const base = makeBase();
    const api = createLeveledMessageApi(base, "none");
    api.success("s");
    api.error("e");
    api.warning("w");
    api.info("i");
    expect(base.success).not.toHaveBeenCalled();
    expect(base.error).not.toHaveBeenCalled();
    expect(base.warning).not.toHaveBeenCalled();
    expect(base.info).not.toHaveBeenCalled();
  });
});
