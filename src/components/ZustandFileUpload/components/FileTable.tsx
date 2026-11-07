import { Button, Table, Tag, Tooltip } from "../../../ui";
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
import { useShallow } from "zustand/react/shallow";
import PercentDisplay from "./PercentDisplay";

interface FileTableProps {
  fileOperations: Pick<
    FileOperationsActions,
    "retryingFiles" | "handleDeleteFile" | "handleRetryUpload"
  >;
  /** T3.3：暂停/继续单个上传任务 */
  pauseUploadFile: (file: UploadFile) => void;
  resumeUploadFile: (file: UploadFile) => void;
}

const FileTable: React.FC<FileTableProps> = ({
  fileOperations,
  pauseUploadFile,
  resumeUploadFile,
}) => {
  const {
    files,
    progressMap,
    speedMap,
    etaMap,
    isUploading,
    isNetworkOffline,
  } = useUploadStore(
    useShallow((state) => ({
      files: state.files,
      progressMap: state.progressMap,
      speedMap: state.speedMap,
      etaMap: state.etaMap,
      isUploading: state.isUploading,
      isNetworkOffline: state.isNetworkOffline,
    }))
  );
  const uploadConfig = useEffectiveUploadConfig();
  const isSimpleMode = uploadConfig.uiMode === "simple";
  const { retryingFiles, handleDeleteFile, handleRetryUpload } = fileOperations;

  const rowIndexById = useMemo(
    () => new Map(files.map((file, index) => [file.id, index + 1])),
    [files]
  );

  const dataSource = useMemo(
    () =>
      files.map((file) => ({
        ...file,
        key: file.id,
        progress: progressMap[file.id] ?? file.progress ?? 0,
        speed: speedMap[file.id] ?? 0,
        eta: etaMap[file.id] ?? 0,
      })),
    [files, progressMap, speedMap, etaMap]
  );

  const visibleColumns = uploadConfig.visibleColumns;

  const columns = useMemo(() => {
    const baseColumns = [
      {
        title: "编号",
        dataIndex: "ID",
        key: "index",
        render: (_: unknown, record: UploadFile) => rowIndexById.get(record.id),
        align: "center" as AlignItem,
        width: "10%",
      },
      { title: "文件名", dataIndex: "fileName", key: "fileName" },
      {
        title: "大小",
        dataIndex: "fileSize",
        key: "fileSize",
        render: (size: number) => `${ByteConvert(size)}`,
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
        render: (status: string) => {
          const statusItem = statusMap[status] || { text: status, color: "default" };
          return <Tag color={statusItem.color}>{statusItem.text}</Tag>;
        },
        align: "center" as AlignItem,
        width: "10%",
      },
      {
        title: "进度",
        dataIndex: "progress",
        key: "progress",
        render: (_: unknown, record: UploadFile) => {
          if (
            record.status === UploadStatus.DONE ||
            record.status === UploadStatus.INSTANT
          ) {
            return <PercentDisplay percent={100} status="success" />;
          }
          if (record.status === UploadStatus.ERROR) {
            return <PercentDisplay percent={record.progress} status="error" />;
          }
          if (record.status === UploadStatus.PAUSED) {
            return (
              <Tooltip title="已暂停，可点击「继续」从断点续传">
                <PercentDisplay percent={record.progress} status="normal" />
              </Tooltip>
            );
          }
          if (record.status === UploadStatus.UPLOADING) {
            return (
              <PercentDisplay
                percent={record.progress}
                status="active"
                speed={record.speed}
                eta={record.eta}
              />
            );
          }
          return <PercentDisplay percent={record.progress} status="normal" />;
        },
        align: "center" as AlignItem,
        width: isSimpleMode ? "20%" : "15%",
      },
    ];

    // simple 模式也保留操作列：失败可重试、可删除，避免死行无法处理
    const actionColumn = {
      title: "操作",
      dataIndex: "action",
      key: "action",
      render: (_: unknown, record: UploadFile) => {
        const { status, id } = record;
        const isRetrying = retryingFiles[id] || false;
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
              disabled={isRetrying || isUploading}
            >
              删除
            </Button>
          </div>
        );
      },
      align: "center" as AlignItem,
      width: "15%",
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
    rowIndexById,
    isSimpleMode,
    retryingFiles,
    isUploading,
    isNetworkOffline,
    pauseUploadFile,
    resumeUploadFile,
    handleRetryUpload,
    handleDeleteFile,
    visibleColumns,
  ]);

  return (
    <Table
      columns={columns}
      dataSource={dataSource}
      pagination={false}
      bordered
      style={{ marginTop: 16 }}
    />
  );
};

export default FileTable;
