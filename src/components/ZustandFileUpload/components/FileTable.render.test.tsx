import React from "react";
import { act, render } from "@testing-library/react";
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
// 只替换 Table 为「记录 props 的空壳」，其余 UI 组件保持真实实现。
vi.mock("../../../ui/table", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    Table: (props: CapturedTableProps) => {
      captured.push(props);
      return null;
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
});
