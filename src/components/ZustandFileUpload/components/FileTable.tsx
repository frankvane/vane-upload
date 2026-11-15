// VU-46：从具体模块具名导入，避免经 ui barrel 拖入整套组件与 CSS 副作用。
import { Button, Tag } from "../../../ui/primitives";
import { Table } from "../../../ui/table";
import React, { useMemo } from "react";
import type { FileOperationsActions } from "../hooks/useFileOperations";
import { useEffectiveUploadConfig } from "../hooks/useEffectiveConfig";
import { useUploadStore } from "../store/upload";
import {
  AlignItem,
  UploadFile,
  UploadStatus,
  statusMap,
} from "../types/upload";
import { ByteConvert } from "../utils";
import ProgressCell from "./ProgressCell";

/**
 * 操作列单元格：内部按单元格订阅 store 的 isUploading / isNetworkOffline /
 * retryingFiles[id]，使整表列定义不再捕获这些会频繁变化的状态，从而上传中 / 离线 /
 * 重试等状态变化只让对应单元格重渲染，而非重建全部列定义击穿 TableRow 的 memo。
 */
interface ActionCellProps {
  record: UploadFile;
  pauseUploadFile: (file: UploadFile) => void;
  resumeUploadFile: (file: UploadFile) => void;
  cancelUploadFile: (file: UploadFile) => void;
  handleRetryUpload: (file: UploadFile) => void;
  handleDeleteFile: (id: string) => void;
}

const ActionCell: React.FC<ActionCellProps> = ({
  record,
  pauseUploadFile,
  resumeUploadFile,
  cancelUploadFile,
  handleRetryUpload,
  handleDeleteFile,
}) => {
  const isUploading = useUploadStore((s) => s.isUploading);
  const isNetworkOffline = useUploadStore((s) => s.isNetworkOffline);
  const isRetrying = useUploadStore((s) => s.retryingFiles[record.id] ?? false);
  const { status, id } = record;
  const isActionDisabled = isUploading || isRetrying || isNetworkOffline;

  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
      {status === UploadStatus.UPLOADING && (
        <Button
          size="small"
          onClick={() => pauseUploadFile(record)}
          disabled={isRetrying || isNetworkOffline}
          title={isNetworkOffline ? "网络已断开，无法暂停" : "暂停上传"}
        >
          暂停
        </Button>
      )}
      {status === UploadStatus.UPLOADING && (
        <Button
          size="small"
          onClick={() => cancelUploadFile(record)}
          disabled={isRetrying}
          title="中止本次传输，保留记录与进度，可稍后点「继续」重新开始"
        >
          取消
        </Button>
      )}
      {status === UploadStatus.PAUSED && (
        <Button
          size="small"
          type="primary"
          onClick={() => resumeUploadFile(record)}
          disabled={isRetrying || isNetworkOffline}
          title={
            isNetworkOffline ? "网络已断开，无法继续" : "从断点继续上传"
          }
        >
          继续
        </Button>
      )}
      {status === UploadStatus.ERROR && (
        <Button
          size="small"
          type="primary"
          onClick={() => handleRetryUpload(record)}
          loading={isRetrying}
          disabled={isActionDisabled}
          title={isNetworkOffline ? "网络已断开，无法重试" : ""}
        >
          {isRetrying ? "重试中" : "重试"}
        </Button>
      )}
      <Button
        size="small"
        danger
        onClick={() => handleDeleteFile(id)}
        // E2E-03：上传中必须可删除——删除会真实中止 Worker，而不是把
        // 记录留在列表里等待一个已无人接手的任务继续写回。
        disabled={isRetrying}
      >
        删除
      </Button>
    </div>
  );
};

interface FileTableProps {
  fileOperations: Pick<
    FileOperationsActions,
    "retryingFiles" | "handleDeleteFile" | "handleRetryUpload"
  >;
  /** T3.3：暂停/继续单个上传任务 */
  pauseUploadFile: (file: UploadFile) => void;
  resumeUploadFile: (file: UploadFile) => void;
  /**
   * E2E-R4：取消单个文件上传——中止传输但保留记录（置 PAUSED，可点「继续」重启），
   * 不清理服务端分片与本地缓存；「删除」才会移除记录并清理两端数据。
   */
  cancelUploadFile: (file: UploadFile) => void;
}

const FileTable: React.FC<FileTableProps> = ({
  fileOperations,
  pauseUploadFile,
  resumeUploadFile,
  cancelUploadFile,
}) => {
  // VU-41：不再订阅三张进度 map。进度订阅下沉到 ProgressCell，
  // 高频进度更新因此完全不会触发 FileTable 重渲染或 dataSource 重建。
  // 操作列的动态状态（isUploading / isNetworkOffline / retryingFiles）已下沉到
  // ActionCell 内部按单元格订阅，故此处只订阅 files，整表列定义不再随上传态变化重建。
  const files = useUploadStore((s) => s.files);
  const uploadConfig = useEffectiveUploadConfig();
  const isSimpleMode = uploadConfig.uiMode === "simple";
  const { handleDeleteFile, handleRetryUpload } = fileOperations;

  // VU-41：直接传 store 里的稳定文件引用，不再每次 map 展开出新 record。
  // Table 改用 rowKey="id"，因此无需额外注入 key 字段。
  const dataSource = files;

  const visibleColumns = uploadConfig.visibleColumns;

  const columns = useMemo(() => {
    const baseColumns = [
      {
        title: "编号",
        dataIndex: "ID",
        key: "index",
        render: (_: unknown, _record: UploadFile, index: number) => index + 1,
        align: "center" as AlignItem,
        width: "10%",
      },
      { title: "文件名", dataIndex: "fileName", key: "fileName" },
      {
        title: "大小",
        dataIndex: "fileSize",
        key: "fileSize",
        render: (_: unknown, record: UploadFile) => `${ByteConvert(record.fileSize)}`,
        align: "right" as AlignItem,
        width: "10%",
      },
      {
        title: "分片数",
        dataIndex: "chunkCount",
        key: "chunkCount",
        align: "center" as AlignItem,
        width: "10%",
      },
      {
        title: "状态",
        dataIndex: "status",
        key: "status",
        render: (_: unknown, record: UploadFile) => {
          const statusItem =
            statusMap[record.status] || { text: record.status, color: "default" };
          return (
            <Tag
              color={statusItem.color}
              // 方案 A：缓存缺失等失败原因需在行内可查，避免「上传失败」后
              // 用户不知道为什么要重新选择文件。
              title={
                record.status === UploadStatus.ERROR
                  ? record.errorMessage
                  : undefined
              }
            >
              {statusItem.text}
            </Tag>
          );
        },
        align: "center" as AlignItem,
        width: "10%",
      },
      {
        title: "进度",
        dataIndex: "progress",
        key: "progress",
        render: (_: unknown, record: UploadFile) => (
          <ProgressCell
            fileId={record.id}
            status={record.status}
            fallbackProgress={record.progress ?? 0}
          />
        ),
        align: "center" as AlignItem,
        width: isSimpleMode ? "20%" : "15%",
      },
    ];

    // simple 模式也保留操作列：失败可重试、可删除，避免死行无法处理。
    // 操作列不再在列定义里捕获 isUploading/isNetworkOffline/retryingFiles，
    // 而是由 ActionCell 按单元格订阅 store，列定义因此保持稳定、不随上传态重建。
    const actionColumn = {
      title: "操作",
      dataIndex: "action",
      key: "action",
      render: (_: unknown, record: UploadFile) => (
        <ActionCell
          record={record}
          pauseUploadFile={pauseUploadFile}
          resumeUploadFile={resumeUploadFile}
          cancelUploadFile={cancelUploadFile}
          handleRetryUpload={handleRetryUpload}
          handleDeleteFile={handleDeleteFile}
        />
      ),
      align: "center" as AlignItem,
      width: "18%",
    };

    // visibleColumns：仅显示并按下标顺序排序列 key；缺省显示全部内置列
    const allColumns = [...baseColumns, actionColumn];
    const columnByKey = new Map(allColumns.map((c) => [c.key, c]));
    const orderedKeys = visibleColumns ?? allColumns.map((c) => c.key);
    return orderedKeys
      .map((key) => columnByKey.get(key))
      .filter(
        (c): c is (typeof allColumns)[number] => c !== undefined
      );
  }, [
    isSimpleMode,
    visibleColumns,
    pauseUploadFile,
    resumeUploadFile,
    cancelUploadFile,
    handleRetryUpload,
    handleDeleteFile,
  ]);

  return (
    <Table
      columns={columns}
      dataSource={dataSource}
      rowKey="id"
      pagination={false}
      bordered
      style={{ marginTop: 16 }}
    />
  );
};

export default FileTable;
