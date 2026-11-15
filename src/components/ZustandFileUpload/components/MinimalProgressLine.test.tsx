import React from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useUploadEngine } from "../context/UploadEngineContext";
import { UploadProvider } from "../context/UploadContext";
import { UploadStatus, type UploadFile } from "../types/upload";
import MinimalProgressLine from "./MinimalProgressLine";

type Store = ReturnType<typeof useUploadEngine>["store"];
let storeRef: Store | null = null;

const Provider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  storeRef = useUploadEngine().store;
  return <>{children}</>;
};

const mount = () => {
  storeRef = null;
  const r = render(
    <UploadProvider settingsSource="props">
      <Provider>
        <MinimalProgressLine />
      </Provider>
    </UploadProvider>
  );
  return { ...r, store: storeRef! };
};

const makeFile = (
  id: string,
  status: UploadStatus,
  fileSize: number,
  progress: number
): UploadFile =>
  ({
    id,
    fileName: `${id}.bin`,
    fileSize,
    fileType: "application/octet-stream",
    lastModified: 0,
    status,
    progress,
    createdAt: 0,
    order: 0,
  }) as unknown as UploadFile;

const rail = () => screen.getByRole("progressbar");

describe("MinimalProgressLine 极简模式聚合进度细线", () => {
  it("文件列表为空时不渲染进度条", () => {
    mount();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("按文件大小加权计算整体百分比", () => {
    // 100B 文件 100% + 300B 文件 50% => (100*100 + 300*50)/400 = 62.5% => 63
    const { store } = mount();
    act(() => {
      store.setState({
        files: [
          makeFile("a", UploadStatus.DONE, 100, 100),
          makeFile("b", UploadStatus.UPLOADING, 300, 50),
        ],
      });
    });
    expect(rail()).toHaveAttribute("aria-valuenow", "63");
  });

  it("实时 progressMap 优先于持久化 progress 快照", () => {
    const { store } = mount();
    act(() => {
      store.setState({
        files: [makeFile("a", UploadStatus.UPLOADING, 100, 10)],
        progressMap: { a: 80 },
      });
    });
    expect(rail()).toHaveAttribute("aria-valuenow", "80");
  });

  it("DONE / INSTANT 恒算 100% 且整条为绿色 success 段", () => {
    const { store } = mount();
    act(() => {
      store.setState({
        files: [
          makeFile("a", UploadStatus.DONE, 100, 100),
          makeFile("b", UploadStatus.INSTANT, 100, 100),
        ],
      });
    });
    expect(rail()).toHaveAttribute("aria-valuenow", "100");
    expect(rail().querySelector('[data-status="success"]')).not.toBeNull();
    expect(rail().querySelector('[data-status="exception"]')).toBeNull();
  });

  it("全部完成只有绿色 success 段，红色不污染已完成部分", () => {
    const { store } = mount();
    act(() => {
      store.setState({
        files: [
          makeFile("a", UploadStatus.DONE, 100, 100),
          makeFile("b", UploadStatus.DONE, 100, 100),
        ],
      });
    });
    expect(rail().querySelector('[data-status="success"]')).not.toBeNull();
    expect(rail().querySelector('[data-status="exception"]')).toBeNull();
    expect(rail().querySelector('[data-status="active"]')).toBeNull();
  });

  it("失败文件只占自己那一段红，已完成部分仍是绿色（不再整条染红）", () => {
    const { store } = mount();
    act(() => {
      store.setState({
        files: [
          makeFile("a", UploadStatus.DONE, 100, 100),
          makeFile("b", UploadStatus.ERROR, 100, 40),
        ],
      });
    });
    // 100B 完成 + 100B 失败 => 各占 50%，红段不再盖住完成段
    const successSeg = rail().querySelector(
      '[data-status="success"]'
    ) as HTMLElement | null;
    const errorSeg = rail().querySelector(
      '[data-status="exception"]'
    ) as HTMLElement | null;
    expect(successSeg).not.toBeNull();
    expect(errorSeg).not.toBeNull();
    expect(successSeg!.style.width).toBe("50%");
    expect(errorSeg!.style.width).toBe("50%");
  });

  it("进行中只有蓝色 active 段（按已传部分），无成功/失败段", () => {
    const { store } = mount();
    act(() => {
      store.setState({
        files: [makeFile("a", UploadStatus.UPLOADING, 100, 30)],
      });
    });
    const activeSeg = rail().querySelector(
      '[data-status="active"]'
    ) as HTMLElement | null;
    expect(activeSeg).not.toBeNull();
    expect(activeSeg!.style.width).toBe("30%");
    expect(rail().querySelector('[data-status="success"]')).toBeNull();
    expect(rail().querySelector('[data-status="exception"]')).toBeNull();
  });

  it("完成后进度条不消失，直到列表清空", () => {
    const { store } = mount();
    act(() => {
      store.setState({ files: [makeFile("a", UploadStatus.DONE, 100, 100)] });
    });
    expect(rail()).toBeInTheDocument();
    expect(rail()).toHaveAttribute("aria-valuenow", "100");
  });

  it("全部失败时整条为红色，无绿色/蓝色段", () => {
    const { store } = mount();
    act(() => {
      store.setState({
        files: [makeFile("a", UploadStatus.ERROR, 100, 40)],
      });
    });
    expect(rail().querySelector('[data-status="exception"]')).not.toBeNull();
    expect(rail().querySelector('[data-status="success"]')).toBeNull();
    expect(rail().querySelector('[data-status="active"]')).toBeNull();
  });

  it("全 0 字节文件按文件数退化，不产生 NaN 宽度", () => {
    const { store } = mount();
    act(() => {
      store.setState({
        files: [
          makeFile("a", UploadStatus.DONE, 0, 100),
          makeFile("b", UploadStatus.UPLOADING, 0, 50),
        ],
      });
    });
    expect(rail()).toHaveAttribute("aria-valuenow", "75");
    const successSeg = rail().querySelector(
      '[data-status="success"]'
    ) as HTMLElement | null;
    expect(successSeg!.style.width).toBe("50%");
  });
});
