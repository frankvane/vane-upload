import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UploadProvider } from "../context/UploadContext";
import { useUploadEngine } from "../context/UploadEngineContext";
import { UploadStatus, type BatchInfo, type UploadFile } from "../types/upload";
import BatchInfoDisplay from "./BatchInfoDisplay";
import NetworkStatusBadge from "./NetworkStatusBadge";
import ProcessProgressDisplay from "./ProcessProgressDisplay";
import StorageStatsDrawer from "./StorageStatsDrawer";

/**
 * T-15：四个纯展示组件的渲染断言。
 *
 * 此前它们的行覆盖率分别为 BatchInfoDisplay 2.77% / StorageStatsDrawer 4.76% /
 * ProcessProgressDisplay 20% / NetworkStatusBadge 27.27% —— 它们没有逻辑，
 * 但**空态、文案分支、交互出口**恰恰是用户唯一看得见的东西，
 * 改动批次统计文案（如 T-14 的「跳过 N 个」）时没有任何测试会红。
 *
 * 每个组件都覆盖三类分支：无数据 / 空列表 / 超长或极端取值。
 */

type Store = ReturnType<typeof useUploadEngine>["store"];
let storeRef: Store | null = null;

const Provider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const engine = useUploadEngine();
  storeRef = engine.store;
  return <>{children}</>;
};

const mount = (ui: React.ReactElement) => {
  storeRef = null;
  const result = render(
    <UploadProvider settingsSource="props">
      <Provider>{ui}</Provider>
    </UploadProvider>
  );
  return { ...result, store: storeRef! };
};

const makeFile = (
  id: string,
  status: UploadStatus,
  fileSize = 1024
): UploadFile =>
  ({
    id,
    fileName: `${id}.bin`,
    fileSize,
    fileType: "application/octet-stream",
    lastModified: 0,
    status,
    progress: 0,
    createdAt: 0,
    order: 0,
  }) as UploadFile;

const batchInfo = (overrides: Partial<BatchInfo> = {}): BatchInfo => ({
  current: 0,
  total: 0,
  queued: 0,
  active: 0,
  completed: 0,
  failed: 0,
  retried: 0,
  ...overrides,
});

const makeBatchUploader = (pendingCleanup = 0) => ({
  forceCleanupUI: vi.fn(async () => undefined),
  pendingCleanupCount: vi.fn(() => pendingCleanup),
  cancelUpload: vi.fn(),
  clearBatchInfo: vi.fn(),
});

describe("T-15 BatchInfoDisplay 渲染", () => {
  it("无批次信息时整体不渲染（悬浮条不占位）", () => {
    const uploader = makeBatchUploader();
    const { store } = mount(<BatchInfoDisplay batchUploader={uploader} />);

    expect(store.getState().batchInfo).toBeNull();
    expect(screen.queryByText("详情")).toBeNull();
    expect(screen.queryByText("上传状态")).toBeNull();
  });

  it("上传中：显示进度文案，抽屉里列出活跃/等待并可取消", () => {
    const uploader = makeBatchUploader();
    const { store } = mount(<BatchInfoDisplay batchUploader={uploader} />);

    act(() => {
      store.getState().setIsUploading(true);
      store
        .getState()
        .setBatchInfo(batchInfo({ current: 1, total: 4, active: 1, queued: 1 }));
    });

    expect(screen.getByText("上传中 1/4")).toBeInTheDocument();

    fireEvent.click(screen.getByText("详情"));
    expect(screen.getByText("上传批次详情")).toBeInTheDocument();
    expect(screen.getByText("活跃:")).toBeInTheDocument();
    expect(screen.getByText("等待:")).toBeInTheDocument();

    fireEvent.click(screen.getByText("取消上传"));
    expect(uploader.cancelUpload).toHaveBeenCalledTimes(1);
  });

  it("完成但有失败与跳过：文案同时区分「失败」和「跳过」（T-14 口径）", () => {
    const uploader = makeBatchUploader();
    const { store } = mount(<BatchInfoDisplay batchUploader={uploader} />);

    act(() => {
      store
        .getState()
        .setBatchInfo(
          batchInfo({ current: 5, total: 5, completed: 2, failed: 2, skipped: 1 })
        );
    });

    expect(
      screen.getByText("上传完成，失败 2 个，跳过 1 个")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("详情"));
    // 抽屉内的「跳过」标签，且不再把跳过算进失败
    expect(screen.getByText("跳过:")).toBeInTheDocument();
    expect(screen.getByText("失败:")).toBeInTheDocument();
  });

  it("全部跳过（无失败）时不显示「失败 0 个」这种噪音", () => {
    const uploader = makeBatchUploader();
    const { store } = mount(<BatchInfoDisplay batchUploader={uploader} />);

    act(() => {
      store
        .getState()
        .setBatchInfo(
          batchInfo({ current: 2, total: 2, completed: 0, skipped: 2 })
        );
    });

    expect(screen.getByText("上传完成 0/2，跳过 2 个")).toBeInTheDocument();
    expect(screen.queryByText(/失败/)).toBeNull();
  });

  it("自动清理倒计时 + 待清理记录：两个按钮都可触发", () => {
    const uploader = makeBatchUploader(3);
    const { store } = mount(<BatchInfoDisplay batchUploader={uploader} />);

    act(() => {
      store
        .getState()
        .setBatchInfo(batchInfo({ current: 2, total: 2, completed: 2, countdown: 5 }));
    });

    expect(screen.getByText("上传完成，5秒后清理")).toBeInTheDocument();

    fireEvent.click(screen.getByText("详情"));
    fireEvent.click(screen.getByText("清理记录"));
    expect(uploader.forceCleanupUI).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("清除信息"));
    expect(uploader.clearBatchInfo).toHaveBeenCalledTimes(1);
  });

  it("极端取值（超长数字）不抛错且进度封顶 100%", () => {
    const uploader = makeBatchUploader();
    const { store } = mount(<BatchInfoDisplay batchUploader={uploader} />);

    // current > total：真实场景出现在「重试两批重叠」时，进度必须封顶到 100%
    act(() => {
      store
        .getState()
        .setBatchInfo(
          batchInfo({ current: 999999, total: 3, completed: 3, retried: 12345 })
        );
    });

    expect(screen.getByText(/999999|3/)).toBeInTheDocument();
  });
});

describe("T-15 StorageStatsDrawer 渲染", () => {
  it("抽屉关闭时不渲染内容", () => {
    const { store } = mount(<StorageStatsDrawer />);

    expect(store.getState().storageStatsVisible).toBe(false);
    expect(screen.queryByText("存储统计")).toBeNull();
  });

  it("打开但列表为空：给出空态而不是悬空的「状态分布」标题", () => {
    const { store } = mount(<StorageStatsDrawer />);
    act(() => {
      store.getState().setStorageStatsVisible(true);
    });

    expect(screen.getByText("存储统计")).toBeInTheDocument();
    expect(screen.getByText("总文件数")).toBeInTheDocument();
    expect(screen.getByText("暂无文件，状态分布为空")).toBeInTheDocument();
    expect(screen.queryByText("状态分布")).toBeNull();
  });

  it("有文件时按状态聚合数量与大小（含超长文件名不参与渲染）", () => {
    const { store } = mount(<StorageStatsDrawer />);
    const longName = `${"超长文件名".repeat(60)}.bin`;
    act(() => {
      store.getState().setFiles([
        makeFile("a", UploadStatus.DONE, 2048),
        makeFile("b", UploadStatus.DONE, 1024),
        makeFile("c", UploadStatus.ERROR, 512),
        { ...makeFile("d", UploadStatus.UPLOADING, 0), fileName: longName },
      ]);
      store.getState().setStorageStatsVisible(true);
    });

    expect(screen.getByText("状态分布")).toBeInTheDocument();
    expect(screen.getByText("已完成 文件")).toBeInTheDocument();
    expect(screen.getByText("上传失败 文件")).toBeInTheDocument();
    expect(screen.getByText("上传中 文件")).toBeInTheDocument();
    // 0 字节文件也计入，不因 size=0 被过滤
    expect(screen.getByText("大小: 0 B")).toBeInTheDocument();
    expect(screen.queryByText("暂无文件，状态分布为空")).toBeNull();
  });

  it("点遮罩关闭会写回 store（不再是本地 state）", () => {
    const { store, container } = mount(<StorageStatsDrawer />);
    act(() => {
      store.getState().setStorageStatsVisible(true);
    });

    const mask = document.querySelector(".rui-drawer-mask");
    expect(mask).not.toBeNull();
    fireEvent.click(mask!);

    expect(store.getState().storageStatsVisible).toBe(false);
    expect(container).toBeTruthy();
  });
});

describe("T-15 ProcessProgressDisplay 渲染", () => {
  it("无进度、非加载、无耗时：整体返回 null", () => {
    const { container } = mount(
      <ProcessProgressDisplay processProgress={null} loading={false} cost={null} />
    );

    expect(container.firstChild).toBeNull();
  });

  it("加载中显示「处理中」标记", () => {
    mount(
      <ProcessProgressDisplay processProgress={null} loading cost={null} />
    );

    expect(screen.getByText("处理中")).toBeInTheDocument();
  });

  it("有进度时显示已处理/总数与耗时", () => {
    mount(
      <ProcessProgressDisplay
        processProgress={{
          processed: 3,
          total: 10,
          success: 3,
          failed: 0,
          oversized: 0,
        }}
        loading={false}
        cost={128}
      />
    );

    expect(screen.getByText("3/10")).toBeInTheDocument();
    expect(screen.getByText("128")).toBeInTheDocument();
    expect(screen.getByText("ms")).toBeInTheDocument();
  });

  it("total 为 0 时进度按 0 处理，不出现 NaN", () => {
    const { container } = mount(
      <ProcessProgressDisplay
        processProgress={{ processed: 0, total: 0, success: 0, failed: 0, oversized: 0 }}
        loading={false}
        cost={null}
      />
    );

    expect(screen.getByText("0/0")).toBeInTheDocument();
    expect(container.textContent).not.toContain("NaN");
  });

  it("超长计数（百万级）不换行溢出（只做数字渲染断言）", () => {
    const { container } = mount(
      <ProcessProgressDisplay
        processProgress={{
          processed: 123456789,
          total: 987654321,
          success: 123456789,
          failed: 0,
          oversized: 0,
        }}
        loading
        cost={999999}
      />
    );

    expect(container.textContent).toContain("123456789/987654321");
    expect(container.textContent).toContain("处理中");
  });
});

describe("T-15 NetworkStatusBadge 渲染", () => {
  const baseProps = {
    networkType: "wifi",
    chunkSize: 1024,
    fileConcurrency: 2,
    chunkConcurrency: 3,
    isOffline: false,
    displayMode: "tooltip" as const,
  };

  it("tooltip 模式只显示状态点与文案", () => {
    mount(<NetworkStatusBadge {...baseProps} />);

    expect(screen.getByText("WiFi")).toBeInTheDocument();
    // 参数详情收在 tooltip 里，不平铺
    expect(screen.queryByText(/分片大小/)).toBeNull();
  });

  it("离线优先于网络类型", () => {
    mount(
      <NetworkStatusBadge {...baseProps} networkType="4g" isOffline />
    );

    expect(screen.getByText("离线")).toBeInTheDocument();
    expect(screen.queryByText("4G")).toBeNull();
  });

  it("direct 模式把参数平铺出来", () => {
    const { container } = mount(
      <NetworkStatusBadge {...baseProps} displayMode="direct" />
    );

    expect(container.textContent).toBe("WiFi1 KB | 2文件 | 3分片");
  });

  it("未知网络类型原样显示（含超长取值不截断、不抛错）", () => {
    const weird = "unknown-network-type-with-a-very-long-name";
    mount(<NetworkStatusBadge {...baseProps} networkType={weird} />);

    expect(screen.getByText(weird)).toBeInTheDocument();
  });

  it("networkType 为空串时回落「未知」而不是空白徽标", () => {
    mount(<NetworkStatusBadge {...baseProps} networkType="" />);

    expect(screen.getByText("未知")).toBeInTheDocument();
  });
});
