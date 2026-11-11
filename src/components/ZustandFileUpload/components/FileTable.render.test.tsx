import React from "react";
import { act, fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

interface CapturedTableProps {
  columns: unknown[];
  dataSource: unknown[];
  rowKey?: string;
}

const { captured } = vi.hoisted(() => ({
  captured: [] as CapturedTableProps[],
}));

// VU-46：FileTable 已改为从 ui/table 具名导入，mock 路径同步收窄到该模块，
// 只替换 Table 为「记录 props 的轻量渲染壳」——按 dataSource/columns 真正渲染出行
// 与单元格，使 columns[].render（尤其是操作列按钮）在 DOM 中可见，从而可对其
// onClick / disabled 做交互断言；同时继续记录 props 供 VU-41 稳定性断言复用。
vi.mock("../../../ui/table", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    Table: (props: CapturedTableProps) => {
      captured.push(props);
      const { columns, dataSource, rowKey = "key" } = props;
      return (
        <table data-testid="file-table-mock">
          <tbody>
            {dataSource.map((record, rowIndex) => {
              const key = (record as Record<string, unknown>)[
                rowKey as string
              ] as React.Key;
              return (
                <tr
                  key={String(key)}
                  className="rui-table-row"
                  data-row-key={String(key)}
                >
                  {(columns as Array<Record<string, unknown>>).map(
                    (col, colIndex) => {
                      const value = (record as Record<string, unknown>)[
                        col.dataIndex as string
                      ];
                      const rendered = col.render
                        ? (
                            col.render as (
                              v: unknown,
                              rec: unknown,
                              idx: number,
                            ) => React.ReactNode
                          )(value, record, rowIndex)
                        : value;
                      return (
                        <td key={(col.key as string) ?? colIndex}>{rendered}</td>
                      );
                    },
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      );
    },
  };
});

import { UploadProvider } from "../context/UploadContext";
import { useUploadEngine } from "../context/UploadEngineContext";
import { UploadStatus, type UploadFile } from "../types/upload";
import FileTable from "./FileTable";

const stableFileOperations = {
  retryingFiles: {} as Record<string, boolean>,
  handleDeleteFile: async () => undefined,
  handleRetryUpload: async () => undefined,
};
const noop = () => undefined;

let storeRef: ReturnType<typeof useUploadEngine>["store"] | null = null;

const Harness = () => {
  const engine = useUploadEngine();
  storeRef = engine.store;
  return (
    <FileTable
      fileOperations={stableFileOperations}
      pauseUploadFile={noop}
      resumeUploadFile={noop}
      cancelUploadFile={noop}
    />
  );
};

const makeFile = (id: string): UploadFile =>
  ({
    id,
    fileName: `${id}.bin`,
    fileSize: 1024,
    status: UploadStatus.UPLOADING,
    progress: 0,
  }) as unknown as UploadFile;

/**
 * VU-41 回归：旧实现每次进度变化都会 map 出全新的 dataSource，
 * 使 TableRow 的 memo 100% 失效。现在断言进度更新根本不会让表格重渲染。
 */
describe("VU-41 FileTable 数据源稳定性", () => {
  it("dataSource 直接复用 store 中的文件引用，进度更新不触发表格重渲染", () => {
    captured.length = 0;
    storeRef = null;

    render(
      <UploadProvider settingsSource="props">
        <Harness />
      </UploadProvider>
    );
    const store = storeRef!;
    expect(captured.length).toBeGreaterThan(0);

    act(() => {
      store.getState().setFiles([makeFile("f-1"), makeFile("f-2")]);
    });
    const afterFiles = captured.at(-1)!;
    expect(afterFiles.dataSource).toHaveLength(2);
    expect(afterFiles.rowKey).toBe("id");
    // 不再展开成 {...file, key, progress, speed, eta} 的新对象
    expect(afterFiles.dataSource[0]).toBe(store.getState().files[0]);
    expect(afterFiles.dataSource[1]).toBe(store.getState().files[1]);

    const renderCountBeforeProgress = captured.length;
    act(() => {
      store.getState().setProgressDetail("f-1", {
        progress: 42,
        speed: 1024,
        eta: 9,
      });
    });

    // 高频进度消息被 ProgressCell 行内订阅吸收，FileTable 与 columns 纹丝不动
    expect(captured.length).toBe(renderCountBeforeProgress);
    expect(captured.at(-1)).toBe(afterFiles);
    expect(store.getState().progressMap["f-1"]).toBe(42);
  });

  it("低频状态变化仍会重建 columns（保证交互按钮状态不陈旧）", () => {
    captured.length = 0;
    storeRef = null;

    render(
      <UploadProvider settingsSource="props">
        <Harness />
      </UploadProvider>
    );
    const store = storeRef!;
    act(() => {
      store.getState().setFiles([makeFile("f-1")]);
    });
    const before = captured.at(-1)!;

    act(() => {
      store.getState().setIsUploading(true);
    });
    const after = captured.at(-1)!;

    expect(after).not.toBe(before);
    expect(after.columns).not.toBe(before.columns);
    // dataSource 仍是同一批文件引用
    expect(after.dataSource).toBe(before.dataSource);
  });

  it("单文件置 DONE 不重建 columns，且未变文件保持同一引用（TableRow memo 不被击穿）", () => {
    captured.length = 0;
    storeRef = null;

    render(
      <UploadProvider settingsSource="props">
        <Harness />
      </UploadProvider>
    );
    const store = storeRef!;
    act(() => {
      store.getState().setFiles([makeFile("f-1"), makeFile("f-2")]);
    });
    const before = captured.at(-1)!;
    const unchangedBefore = before.dataSource[1];

    // 单文件状态变化：files 数组必然换新，但列定义不应随之重建，
    // 否则真实表格里全部 TableRow 的 memo 被击穿、O(N) 重渲染。
    act(() => {
      store.getState().patchFile("f-1", { status: UploadStatus.DONE, progress: 100 });
    });
    const after = captured.at(-1)!;

    expect(after.columns).toBe(before.columns);
    // 未变化的文件对象引用稳定 -> 该行不会因父级重渲染而重渲染
    expect(after.dataSource[1]).toBe(unchangedBefore);
    // 变化行是新对象，会被对应 TableRow 正常重渲染（仅 1 行，而非全表）
    expect(after.dataSource[0]).not.toBe(before.dataSource[0]);
  });
});

/**
 * T-71：操作列交互断言。Table 已被上面的 mock 改为「轻量渲染壳」，操作列的 5 个按钮
 * 真正渲染进 DOM，因此其 onClick 与 disabled 分支均可被断言。每条断言都精确到具体的
 * 禁用条件，改坏任一按钮的 disabled 逻辑都会让用例转红。
 */
type ActionHandlers = {
  pauseUploadFile: ReturnType<typeof vi.fn>;
  resumeUploadFile: ReturnType<typeof vi.fn>;
  cancelUploadFile: ReturnType<typeof vi.fn>;
  handleDeleteFile: ReturnType<typeof vi.fn>;
  handleRetryUpload: ReturnType<typeof vi.fn>;
};

const makeHandlers = (): ActionHandlers => ({
  pauseUploadFile: vi.fn(),
  resumeUploadFile: vi.fn(),
  cancelUploadFile: vi.fn(),
  handleDeleteFile: vi.fn(),
  handleRetryUpload: vi.fn(),
});

// useUploadStore 是读取 UploadStoreContext 的 hook，测试里要拿 store 实例本身须经由
// useUploadEngine().store（与 VU-41 用例同一来源）；CaptureStore 把实例抓到 actionStoreRef。
let actionStoreRef: ReturnType<typeof useUploadEngine>["store"] | null = null;
const CaptureStore: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  actionStoreRef = useUploadEngine().store;
  return <>{children}</>;
};

const renderActionTable = (
  files: UploadFile[],
  handlers: ActionHandlers,
  opts: { isNetworkOffline?: boolean; isUploading?: boolean } = {},
) => {
  const utils = render(
    <UploadProvider settingsSource="props">
      <CaptureStore>
        <FileTable
          fileOperations={{
            retryingFiles: {},
            handleDeleteFile: handlers.handleDeleteFile,
            handleRetryUpload: handlers.handleRetryUpload,
          }}
          pauseUploadFile={handlers.pauseUploadFile}
          resumeUploadFile={handlers.resumeUploadFile}
          cancelUploadFile={handlers.cancelUploadFile}
        />
      </CaptureStore>
    </UploadProvider>,
  );
  const store = actionStoreRef!;
  act(() => {
    store.getState().setFiles(files);
  });
  if (opts.isNetworkOffline !== undefined) {
    // store 无 setIsNetworkOffline action，离线态由网络探测 hook 经 setState 写入
    act(() => store.setState({ isNetworkOffline: opts.isNetworkOffline }));
  }
  if (opts.isUploading !== undefined) {
    act(() => store.getState().setIsUploading(opts.isUploading));
  }
  return utils;
};

describe("T-71 FileTable 操作列交互断言", () => {
  it.each([
    [UploadStatus.UPLOADING, ["暂停", "取消", "删除"]],
    [UploadStatus.PAUSED, ["继续", "删除"]],
    [UploadStatus.ERROR, ["重试", "删除"]],
    [UploadStatus.DONE, ["删除"]],
    [UploadStatus.INSTANT, ["删除"]],
  ])("状态 %s 渲染正确的操作按钮集合", (status, expected) => {
    const handlers = makeHandlers();
    const file = { ...makeFile("f-1"), status } as UploadFile;
    const { container } = renderActionTable([file], handlers);
    const row = container.querySelector(".rui-table-row")!;
    const labels = Array.from(row.querySelectorAll("button")).map((b) =>
      (b.textContent ?? "").trim(),
    );
    expect(labels).toEqual(expected);
  });

  it("点击操作按钮触发对应回调（暂停/取消/继续/重试/删除）", () => {
    const handlers = makeHandlers();
    const uploading = {
      ...makeFile("u-1"),
      status: UploadStatus.UPLOADING,
    } as UploadFile;
    const paused = {
      ...makeFile("p-1"),
      status: UploadStatus.PAUSED,
    } as UploadFile;
    const error = { ...makeFile("e-1"), status: UploadStatus.ERROR } as UploadFile;
    const { container } = renderActionTable(
      [uploading, paused, error],
      handlers,
    );

    const rows = container.querySelectorAll(".rui-table-row");
    const row0 = rows[0] as HTMLElement;
    fireEvent.click(within(row0).getByText("暂停"));
    expect(handlers.pauseUploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u-1" }),
    );
    fireEvent.click(within(row0).getByText("取消"));
    expect(handlers.cancelUploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u-1" }),
    );
    fireEvent.click(within(row0).getByText("删除"));
    expect(handlers.handleDeleteFile).toHaveBeenCalledWith("u-1");

    const row1 = rows[1] as HTMLElement;
    fireEvent.click(within(row1).getByText("继续"));
    expect(handlers.resumeUploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p-1" }),
    );

    const row2 = rows[2] as HTMLElement;
    fireEvent.click(within(row2).getByText("重试"));
    expect(handlers.handleRetryUpload).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e-1" }),
    );
  });

  it("离线时 暂停/继续/重试 禁用，取消/删除 仍可用", () => {
    const handlers = makeHandlers();
    const uploading = {
      ...makeFile("u-1"),
      status: UploadStatus.UPLOADING,
    } as UploadFile;
    const paused = {
      ...makeFile("p-1"),
      status: UploadStatus.PAUSED,
    } as UploadFile;
    const error = { ...makeFile("e-1"), status: UploadStatus.ERROR } as UploadFile;
    const { container } = renderActionTable(
      [uploading, paused, error],
      handlers,
      { isNetworkOffline: true },
    );

    const rows = container.querySelectorAll(".rui-table-row");
    const row0 = rows[0] as HTMLElement;
    expect(within(row0).getByText("暂停")).toBeDisabled();
    expect(within(row0).getByText("取消")).not.toBeDisabled();
    expect(within(row0).getByText("删除")).not.toBeDisabled();
    const row1 = rows[1] as HTMLElement;
    expect(within(row1).getByText("继续")).toBeDisabled();
    const row2 = rows[2] as HTMLElement;
    expect(within(row2).getByText("重试")).toBeDisabled();
    expect(within(row2).getByText("删除")).not.toBeDisabled();
  });

  it("上传进行中（isActionDisabled）时 重试 禁用", () => {
    const handlers = makeHandlers();
    const error = { ...makeFile("e-1"), status: UploadStatus.ERROR } as UploadFile;
    const { container } = renderActionTable([error], handlers, {
      isUploading: true,
    });
    const row = container.querySelector(".rui-table-row") as HTMLElement;
    expect(within(row).getByText("重试")).toBeDisabled();
    // 离线无关、非重试状态：删除始终可用（除非正在重试）
    expect(within(row).getByText("删除")).not.toBeDisabled();
  });

  it("某文件正在重试时，其所有操作按钮禁用（含 loading 态）", () => {
    const handlers = makeHandlers();
    const error = { ...makeFile("e-1"), status: UploadStatus.ERROR } as UploadFile;
    const utils = render(
      <UploadProvider settingsSource="props">
        <CaptureStore>
          <FileTable
            fileOperations={{
              retryingFiles: { "e-1": true },
              handleDeleteFile: handlers.handleDeleteFile,
              handleRetryUpload: handlers.handleRetryUpload,
            }}
            pauseUploadFile={handlers.pauseUploadFile}
            resumeUploadFile={handlers.resumeUploadFile}
            cancelUploadFile={handlers.cancelUploadFile}
          />
        </CaptureStore>
      </UploadProvider>,
    );
    act(() => {
      actionStoreRef!.getState().setFiles([error]);
    });
    const row = utils.container.querySelector(".rui-table-row") as HTMLElement;
    // 正在重试时 重试 按钮显示「重试中」且禁用
    expect(within(row).getByText("重试中")).toBeDisabled();
    expect(within(row).getByText("删除")).toBeDisabled();
  });
});
