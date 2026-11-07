import { Button, Drawer, Progress, Space, Tag, Typography } from "../../../ui";
import React, { useEffect, useState } from "react";
import { useUploadStore } from "../store/upload";
import type { BatchUploaderActions } from "../hooks/useBatchUploader";
import { useShallow } from "zustand/react/shallow";
import { debugError } from "./../../../shared/debugLogger";

interface BatchInfoDisplayProps {
  batchUploader: Pick<
    BatchUploaderActions,
    "forceCleanupUI" | "pendingCleanupCount" | "cancelUpload" | "clearBatchInfo"
  >;
}

const BatchInfoDisplay: React.FC<BatchInfoDisplayProps> = ({ batchUploader }) => {
  const { batchInfo, isUploading } = useUploadStore(
    useShallow((state) => ({
      batchInfo: state.batchInfo,
      isUploading: state.isUploading,
    }))
  );
  const { forceCleanupUI, pendingCleanupCount, cancelUpload, clearBatchInfo } =
    batchUploader;
  const [drawerOpen, setDrawerOpen] = useState(false);

  const current = batchInfo?.current ?? 0;
  const total = batchInfo?.total ?? 0;
  const completed = batchInfo?.completed ?? 0;
  const failed = batchInfo?.failed ?? 0;
  const retried = batchInfo?.retried ?? 0;
  const queued = batchInfo?.queued ?? 0;
  const active = batchInfo?.active ?? 0;
  const countdown = batchInfo?.countdown;

  const validatedCurrent = Math.min(current, total);
  const validatedTotal = Math.max(total, completed + failed);
  const percent =
    validatedTotal > 0
      ? Math.floor((validatedCurrent / validatedTotal) * 100)
      : 0;
  const isCompleted = validatedCurrent === validatedTotal;
  const pendingCount = pendingCleanupCount();
  const hasCountdown = countdown !== undefined && countdown > 0;

  const shouldShowDock = Boolean(batchInfo) && (
    isUploading || failed > 0 || retried > 0 || pendingCount > 0 || hasCountdown
  );

  useEffect(() => {
    if (!shouldShowDock && drawerOpen) {
      setDrawerOpen(false);
    }
  }, [shouldShowDock, drawerOpen]);

  const statusText = (() => {
    if (isUploading) {
      return `上传中 ${validatedCurrent}/${validatedTotal}`;
    }
    if (failed > 0) {
      return `上传完成，失败 ${failed} 个`;
    }
    if (hasCountdown) {
      return `上传完成，${countdown}秒后清理`;
    }
    return `上传完成 ${completed}/${validatedTotal}`;
  })();

  if (!shouldShowDock) {
    return null;
  }

  return (
    <>
      <div
        style={{
          position: "fixed",
          right: 16,
          bottom: 16,
          zIndex: 900,
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 10,
          padding: "8px 10px",
          minWidth: 260,
          boxShadow: "0 8px 24px rgba(0,0,0,0.10)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Tag color={isCompleted ? "success" : "processing"}>
            {isUploading ? "上传中" : "上传状态"}
          </Tag>
          <Typography.Text style={{ fontSize: 12 }}>{statusText}</Typography.Text>
        </div>
        <Button size="small" type="link" onClick={() => setDrawerOpen(true)}>
          详情
        </Button>
      </div>

      <Drawer
        title="上传批次详情"
        placement="right"
        width={420}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <span>
              活跃: <Tag color="processing">{active}</Tag>
            </span>
            <span>
              等待: <Tag color="default">{queued}</Tag>
            </span>
            <span>
              完成: <Tag color="success">{completed}</Tag>
            </span>
            {failed > 0 && (
              <span>
                失败: <Tag color="error">{failed}</Tag>
              </span>
            )}
            {retried > 0 && (
              <span>
                重试: <Tag color="warning">{retried}</Tag>
              </span>
            )}
            {hasCountdown && (
              <span>
                倒计时: <Tag color="cyan">{countdown}秒</Tag>
              </span>
            )}
          </div>

          <Typography.Text>
            批量上传进度: {validatedCurrent}/{validatedTotal}
          </Typography.Text>
          <Progress
            percent={percent}
            status={isCompleted ? "success" : "active"}
            size="small"
          />

          <Space>
            {pendingCount > 0 && (
              <Button
                onClick={() => {
                  forceCleanupUI().catch((err) => {
                    debugError("cleanup failed", err);
                  });
                }}
              >
                清理记录
              </Button>
            )}
            {isUploading ? (
              <Button danger onClick={cancelUpload}>
                取消上传
              </Button>
            ) : (
              <Button onClick={clearBatchInfo}>清除信息</Button>
            )}
          </Space>
        </Space>
      </Drawer>
    </>
  );
};

export default BatchInfoDisplay;
