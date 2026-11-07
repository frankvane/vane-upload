import { BarChartOutlined } from "../../../ui";
import { Button, InputNumber, Switch, Tooltip } from "../../../ui";
import React, { useMemo } from "react";
import type { BatchUploaderActions } from "../hooks/useBatchUploader";
import type { FileOperationsActions } from "../hooks/useFileOperations";
import { useEffectiveUploadConfig } from "../hooks/useEffectiveConfig";
import { useUploadStore } from "../store/upload";
import { useShallow } from "zustand/react/shallow";
import { NetworkStatusBadge, ProcessProgressDisplay } from "./";

interface FileUploadActionsProps {
  triggerFileInput: () => void;
  batchUploader: Pick<BatchUploaderActions, "uploadAll">;
  fileOperations: Pick<
    FileOperationsActions,
    "handleClearList" | "handleRetryAllUpload"
  >;
}

const FileUploadActions: React.FC<FileUploadActionsProps> = ({
  triggerFileInput,
  batchUploader,
  fileOperations,
}) => {
  const {
    files,
    isUploading,
    isRetryingAll,
    isNetworkOffline,
    loading,
    cost,
    processProgress,
  } = useUploadStore(
    useShallow((state) => ({
      files: state.files,
      isUploading: state.isUploading,
      isRetryingAll: state.isRetryingAll,
      isNetworkOffline: state.isNetworkOffline,
      loading: state.loading,
      cost: state.cost,
      processProgress: state.processProgress,
    }))
  );
  const {
    setAutoUpload,
    setAutoCleanup,
    setCleanupDelay,
    setNetworkDisplayMode,
    networkType,
    chunkSize,
    fileConcurrency,
    chunkConcurrency,
    setStorageStatsVisible,
  } = useUploadStore(
    useShallow((state) => ({
      setAutoUpload: state.setAutoUpload,
      setAutoCleanup: state.setAutoCleanup,
      setCleanupDelay: state.setCleanupDelay,
      setNetworkDisplayMode: state.setNetworkDisplayMode,
      networkType: state.networkType,
      chunkSize: state.chunkSize,
      fileConcurrency: state.fileConcurrency,
      chunkConcurrency: state.chunkConcurrency,
      setStorageStatsVisible: state.setStorageStatsVisible,
    }))
  );

  const { uploadAll } = batchUploader;
  const { handleClearList, handleRetryAllUpload } = fileOperations;
  const uploadConfig = useEffectiveUploadConfig();
  const isSimpleMode = uploadConfig.uiMode === "simple";

  const errorFilesCount = useMemo(
    () => files.filter((file) => file.status === "error").length,
    [files]
  );

  const retryButtonTitle =
    errorFilesCount > 0 ? `批量重试 (${errorFilesCount})` : "批量重试";

  const showStorageStats = () => {
    setStorageStatsVisible(true);
  };

  const handleCleanupDelayChange = (value: number | null) => {
    if (value !== null && value >= 1) {
      setCleanupDelay(value);
    }
  };

  return (
    <div
      style={{
        marginTop: 16,
        marginBottom: 16,
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        rowGap: 8,
        gap: 8,
        justifyContent: isSimpleMode ? "flex-start" : "space-between",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          rowGap: 8,
          gap: 8,
        }}
      >
        <Button
          onClick={triggerFileInput}
          disabled={isNetworkOffline}
          title={isNetworkOffline ? "网络已断开，无法选择文件" : ""}
        >
          选择文件
        </Button>

        {!isSimpleMode && (
          <>
            <Button
              type="primary"
              onClick={uploadAll}
              disabled={
                files.length === 0 ||
                isUploading ||
                isRetryingAll ||
                isNetworkOffline
              }
              title={isNetworkOffline ? "网络已断开，无法上传" : ""}
            >
              上传文件
            </Button>

            <Button
              type="primary"
              danger
              onClick={handleClearList}
              disabled={files.length === 0 || isUploading || isRetryingAll}
            >
              清除列表
            </Button>

            <Tooltip
              title={
                isNetworkOffline
                  ? "网络已断开，无法重试"
                  : errorFilesCount > 0
                  ? `重试 ${errorFilesCount} 个失败文件`
                  : "没有可重试文件"
              }
            >
              <Button
                type="primary"
                onClick={handleRetryAllUpload}
                disabled={
                  errorFilesCount === 0 ||
                  isUploading ||
                  isRetryingAll ||
                  isNetworkOffline
                }
                loading={isRetryingAll}
              >
                {isRetryingAll ? "重试中..." : retryButtonTitle}
              </Button>
            </Tooltip>

            {(loading || processProgress || cost !== null) && (
              <ProcessProgressDisplay
                loading={loading}
                processProgress={processProgress}
                cost={cost}
              />
            )}
          </>
        )}
      </div>

      {!isSimpleMode && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            rowGap: 8,
            gap: 12,
          }}
        >
          <NetworkStatusBadge
            networkType={networkType}
            chunkSize={chunkSize}
            fileConcurrency={fileConcurrency}
            chunkConcurrency={chunkConcurrency}
            isOffline={isNetworkOffline}
            displayMode={uploadConfig.networkDisplayMode}
          />

          <Tooltip
            title={`切换到${
              uploadConfig.networkDisplayMode === "direct" ? "悬停提示" : "直接显示"
            }模式`}
          >
            <Switch
              checkedChildren="详细"
              unCheckedChildren="简洁"
              checked={uploadConfig.networkDisplayMode === "direct"}
              onChange={(checked) =>
                setNetworkDisplayMode(checked ? "direct" : "tooltip")
              }
              size="small"
            />
          </Tooltip>

          <Tooltip title={`${uploadConfig.autoUpload ? "关闭" : "开启"}自动上传`}>
            <div style={{ display: "flex", alignItems: "center", fontSize: 13 }}>
              <span
                style={{
                  marginRight: 6,
                  color: "var(--rui-text-secondary)",
                  whiteSpace: "nowrap",
                }}
              >
                自动上传
              </span>
              <Switch
                checked={uploadConfig.autoUpload}
                onChange={(checked) => setAutoUpload(checked)}
                size="small"
              />
            </div>
          </Tooltip>

          <Tooltip title={`${uploadConfig.autoCleanup ? "关闭" : "开启"}自动清理`}>
            <div style={{ display: "flex", alignItems: "center", fontSize: 13 }}>
              <span
                style={{
                  marginRight: 6,
                  color: "var(--rui-text-secondary)",
                  whiteSpace: "nowrap",
                }}
              >
                自动清理
              </span>
              <Switch
                checked={uploadConfig.autoCleanup}
                onChange={(checked) => setAutoCleanup(checked)}
                size="small"
              />
            </div>
          </Tooltip>

          <Tooltip title="设置清理延时（秒）">
            <div style={{ display: "flex", alignItems: "center", fontSize: 13 }}>
              <span
                style={{
                  marginRight: 6,
                  color: "var(--rui-text-secondary)",
                  whiteSpace: "nowrap",
                }}
              >
                延时(秒)
              </span>
              <InputNumber
                min={1}
                max={60}
                value={uploadConfig.cleanupDelay}
                onChange={handleCleanupDelayChange}
                size="small"
                style={{ width: 60 }}
              />
            </div>
          </Tooltip>

          <Tooltip title="存储统计">
            <Button
              type="text"
              icon={<BarChartOutlined />}
              onClick={showStorageStats}
              size="small"
            />
          </Tooltip>
        </div>
      )}
    </div>
  );
};

export default FileUploadActions;
