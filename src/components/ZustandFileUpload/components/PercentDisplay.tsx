import { Progress } from "../../../ui";
import React from "react";

interface PercentDisplayProps {
  percent: number;
  status?: "normal" | "active" | "success" | "exception" | "error";
  /** T3.4：瞬时速率（字节/秒），与 eta 同现则展示 MB/s */
  speed?: number;
  /** T3.4：预计剩余时间（秒） */
  eta?: number;
}

const formatSpeed = (bytesPerSec: number): string => {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return "";
  }
  const mb = bytesPerSec / (1024 * 1024);
  if (mb >= 1) {
    return `${mb.toFixed(1)} MB/s`;
  }
  const kb = bytesPerSec / 1024;
  return `${kb.toFixed(0)} KB/s`;
};

const formatEta = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}分${s}秒`;
  }
  return `${Math.round(seconds)}秒`;
};

// forwardRef：FileTable 里被 Tooltip 包裹，Tooltip 会 cloneElement 注入 ref
const PercentDisplay = React.forwardRef<HTMLDivElement, PercentDisplayProps>(
  ({ percent, status = "normal", speed, eta }, ref) => {
    // 将status转换为Progress组件可接受的类型
    const progressStatus = status === "error" ? "exception" : status;
    const speedText = formatSpeed(speed ?? 0);
    const etaText = formatEta(eta ?? 0);
    const hasDetail = Boolean(speedText || etaText);

    return (
      <div ref={ref} style={{ minWidth: 120 }}>
        <Progress
          percent={percent}
          status={
            progressStatus as
              | "success"
              | "exception"
              | "normal"
              | "active"
              | undefined
          }
          size="small"
          format={(percent) => `${Math.floor(percent || 0)}%`}
        />
        {hasDetail && (
          <div
            style={{
              fontSize: 11,
              color: "rgba(0,0,0,0.45)",
              marginTop: -2,
              whiteSpace: "nowrap",
            }}
          >
            {speedText}
            {speedText && etaText ? " · 剩余 " : ""}
            {etaText ? `${etaText}` : ""}
          </div>
        )}
      </div>
    );
  },
);

PercentDisplay.displayName = "PercentDisplay";

export default PercentDisplay;
