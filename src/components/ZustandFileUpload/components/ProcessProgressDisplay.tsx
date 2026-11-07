import { Progress, Statistic, Tag } from "../../../ui";

import { ClockCircleOutlined } from "../../../ui";
import { ProcessProgress } from "../types/upload";
import React from "react";

interface ProcessProgressDisplayProps {
  processProgress: ProcessProgress | null;
  loading: boolean;
  cost: number | null;
}

const ProcessProgressDisplay: React.FC<ProcessProgressDisplayProps> = ({
  processProgress,
  loading,
  cost,
}) => {
  if (!loading && !processProgress && cost === null) {
    return null;
  }

  // 计算进度百分比
  const percent =
    processProgress && processProgress.total > 0
      ? Math.floor((processProgress.processed / processProgress.total) * 100)
      : 0;

  return (
    <div
      style={{ display: "inline-flex", alignItems: "center", marginLeft: 16 }}
    >
      {processProgress && (
        <div style={{ display: "flex", alignItems: "center", marginRight: 16 }}>
          <span style={{ fontSize: "12px", marginRight: 8 }}>
            {processProgress.processed}/{processProgress.total}
          </span>
          <Progress
            percent={percent}
            status={loading ? "active" : "success"}
            size="small"
            style={{ width: 80, marginBottom: 0 }}
          />
        </div>
      )}

      {loading && (
        <Tag color="processing" style={{ marginRight: 8 }}>
          处理中
        </Tag>
      )}

      {cost !== null && (
        <Statistic
          value={cost}
          suffix="ms"
          prefix={<ClockCircleOutlined />}
          valueStyle={{ fontSize: "14px" }}
          style={{ marginLeft: 8 }}
        />
      )}
    </div>
  );
};

export default ProcessProgressDisplay;
