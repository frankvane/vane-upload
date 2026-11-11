import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import FileUploadActions from "./FileUploadActions";
import { useUploadEngine } from "../context/UploadEngineContext";
import { UploadProvider } from "../context/UploadContext";
import { useUploadStore } from "../store/upload";
import { useShallow } from "zustand/react/shallow";
import type { UploadFile } from "../types/upload";

type Store = ReturnType<typeof useUploadEngine>["store"];
let storeRef: Store | null = null;

const Provider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  storeRef = useUploadEngine().store;
  return <>{children}</>;
};

const mount = (ui: React.ReactElement) => {
  storeRef = null;
  const r = render(
    <UploadProvider settingsSource="props">
      <Provider>{ui}</Provider>
    </UploadProvider>,
  );
  return { ...r, store: storeRef! };
};

const baseProps = () => ({
  triggerFileInput: vi.fn(),
  batchUploader: { uploadAll: vi.fn() },
  fileOperations: {
    handleClearList: vi.fn(),
    handleRetryAllUpload: vi.fn(),
  },
});

const makeFile = (id: string, status: string): UploadFile =>
  ({
    id,
    fileName: `${id}.bin`,
    fileSize: 1,
    fileType: "application/octet-stream",
    lastModified: 0,
    status,
    progress: 0,
    createdAt: 0,
    order: 0,
  }) as unknown as UploadFile;

describe("FileUploadActions", () => {
  it("full 模式渲染核心按钮；无文件时上传禁用，有文件后可点触发 uploadAll", () => {
    const props = baseProps();
    const { store } = mount(<FileUploadActions {...props} />);

    expect(screen.getByText("选择文件")).toBeInTheDocument();
    expect(screen.getByText("上传文件")).toBeInTheDocument();
    expect(screen.getByText("清除列表")).toBeInTheDocument();

    const uploadBtn = screen.getByText("上传文件");
    expect(uploadBtn).toBeDisabled();

    act(() => {
      store.setState({ files: [makeFile("a", "waiting")] });
    });
    expect(uploadBtn).toBeEnabled();
    fireEvent.click(uploadBtn);
    expect(props.batchUploader.uploadAll).toHaveBeenCalledTimes(1);
  });

  it("清除列表按钮触发 handleClearList", () => {
    const props = baseProps();
    const { store } = mount(<FileUploadActions {...props} />);
    act(() => {
      store.setState({ files: [makeFile("a", "waiting")] });
    });
    fireEvent.click(screen.getByText("清除列表"));
    expect(props.fileOperations.handleClearList).toHaveBeenCalledTimes(1);
  });

  it("网络断开时选择/上传按钮禁用并带提示文案", () => {
    const props = baseProps();
    const { store } = mount(<FileUploadActions {...props} />);
    act(() => {
      store.setState({ isNetworkOffline: true });
    });
    const choose = screen.getByText("选择文件");
    expect(choose).toBeDisabled();
    expect(choose.getAttribute("title")).toContain("网络已断开");
    expect(screen.getByText("上传文件")).toBeDisabled();
  });

  it("存在失败文件时批量重试按钮显示计数", () => {
    const props = baseProps();
    const { store } = mount(<FileUploadActions {...props} />);
    act(() => {
      store.setState({
        files: [makeFile("a", "error"), makeFile("b", "waiting")],
      });
    });
    expect(screen.getByText("批量重试 (1)")).toBeInTheDocument();
    const retry = screen.getByText("批量重试 (1)");
    expect(retry).not.toBeDisabled();
    fireEvent.click(retry);
    expect(props.fileOperations.handleRetryAllUpload).toHaveBeenCalledTimes(1);
  });

  it("T-69：files 引用变化但 errorCount/数量不变时工具栏不重渲染", () => {
    const props = baseProps();
    let toolbarRenders = 0;
    // 探针订阅与工具栏相同的派生标量，二者重渲染同频 -> 计数即工具栏重渲染次数。
    const Probe: React.FC = () => {
      useUploadStore(
        useShallow((s) => ({
          errorCount: s.files.filter((f) => f.status === "error").length,
          filesLength: s.files.length,
        })),
      );
      toolbarRenders += 1;
      return <FileUploadActions {...props} />;
    };
    const { store } = mount(<Probe />);
    const base = toolbarRenders; // 初始渲染

    act(() => {
      store.getState().setFiles([makeFile("a", "waiting"), makeFile("b", "waiting")]);
    });
    const afterAdd = toolbarRenders; // 数量 0 -> 2：应重渲染一次
    expect(afterAdd).toBe(base + 1);

    // 单文件在「非 error」状态间流转：errorCount 与数量都不变 -> 工具栏不应重渲染
    act(() => {
      store.getState().patchFile("a", { status: "uploading" });
    });
    expect(toolbarRenders).toBe(afterAdd);

    // errorCount 真正变化（出现失败文件）：应重渲染一次
    act(() => {
      store.getState().patchFile("b", { status: "error" });
    });
    expect(toolbarRenders).toBe(afterAdd + 1);
  });
});
