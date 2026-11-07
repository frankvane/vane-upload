import { Card, Col, Drawer, Empty, Progress, Row, Statistic, Typography } from "../../../ui";
import React, { useEffect, useState } from "react";

import { ByteConvert } from "../utils";
import { UploadStatus, statusMap } from "../types/upload";
import { useUploadStore } from "../store/upload";
import { useShallow } from "zustand/react/shallow";

const { Title } = Typography;

interface StorageStats {
  totalFiles: number;
  totalSize: number;
  statusCounts: Record<string, number>;
  statusSizes: Record<string, number>;
}

const StorageStatsDrawer: React.FC = () => {
  const { files, storageStatsVisible, setStorageStatsVisible } =
    useUploadStore(
      useShallow((state) => ({
        files: state.files,
        storageStatsVisible: state.storageStatsVisible,
        setStorageStatsVisible: state.setStorageStatsVisible,
      }))
    );
  const [stats, setStats] = useState<StorageStats>({
    totalFiles: 0,
    totalSize: 0,
    statusCounts: {},
    statusSizes: {},
  });

  // 计算统计信息
  useEffect(() => {
    if (!storageStatsVisible) return;

    const statusCounts: Record<string, number> = {};
    const statusSizes: Record<string, number> = {};
    let totalSize = 0;

    // 初始化所有状态计数
    Object.values(UploadStatus).forEach((status) => {
      statusCounts[status] = 0;
      statusSizes[status] = 0;
    });

    // 统计文件数量和大小
    files.forEach((file) => {
      const status = file.status;
      statusCounts[status] = (statusCounts[status] || 0) + 1;
      statusSizes[status] = (statusSizes[status] || 0) + file.fileSize;
      totalSize += file.fileSize;
    });

    setStats({
      totalFiles: files.length,
      totalSize,
      statusCounts,
      statusSizes,
    });
  }, [files, storageStatsVisible]);

  // 生成状态统计卡片
  const renderStatusCards = () => {
    if (stats.totalFiles === 0) return null;

    const statusItems = Object.entries(stats.statusCounts)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => {
        const percent = Math.round((count / stats.totalFiles) * 100);
        const size = stats.statusSizes[status] || 0;
        const sizePercent = stats.totalSize
          ? Math.round((size / stats.totalSize) * 100)
          : 0;
        const statusText = statusMap[status]?.text ?? status;

        let color = "";
        switch (status) {
          case UploadStatus.DONE:
          case UploadStatus.INSTANT:
            color = "#52c41a"; // 绿色
            break;
          case UploadStatus.ERROR:
            color = "#f5222d"; // 红色
            break;
          case UploadStatus.UPLOADING:
          case UploadStatus.PREPARING_UPLOAD:
            color = "#1890ff"; // 蓝色
            break;
          case UploadStatus.PAUSED:
            color = "#faad14"; // 黄色
            break;
          default:
            color = "#d9d9d9"; // 灰色
        }

        return (
          <Col span={8} key={status}>
            <Card size="small" style={{ marginBottom: 16 }}>
              <Statistic
                title={`${statusText} 文件`}
                value={count}
                suffix={`/ ${stats.totalFiles}`}
              />
              <Progress percent={percent} strokeColor={color} size="small" />
              <div style={{ marginTop: 8 }}>
                <span>大小: {ByteConvert(size)}</span>
                <Progress
                  percent={sizePercent}
                  strokeColor={color}
                  size="small"
                />
              </div>
            </Card>
          </Col>
        );
      });

    return <Row gutter={16}>{statusItems}</Row>;
  };

  return (
    <Drawer
      title="存储统计"
      placement="right"
      width={500}
      onClose={() => setStorageStatsVisible(false)}
      open={storageStatsVisible}
    >
      <Title level={4}>总体统计</Title>
      <Row gutter={16}>
        <Col span={12}>
          <Card>
            <Statistic title="总文件数" value={stats.totalFiles} />
          </Card>
        </Col>
        <Col span={12}>
          <Card>
            <Statistic
              title="总存储大小"
              value={ByteConvert(stats.totalSize)}
            />
          </Card>
        </Col>
      </Row>

      {stats.totalFiles > 0 ? (
        <>
          <Title level={4} style={{ marginTop: 24 }}>
            状态分布
          </Title>
          {renderStatusCards()}
        </>
      ) : (
        // 无文件时渲染空态，避免悬空的「状态分布」标题贴着上一节内容
        <div style={{ marginTop: 24 }}>
          <Empty description="暂无文件，状态分布为空" />
        </div>
      )}
    </Drawer>
  );
};

export default StorageStatsDrawer;
