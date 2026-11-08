import React from "react";
import { useShallow } from "zustand/react/shallow";

import { Tooltip } from "../../../ui/feedback";
import { useUploadStore } from "../store/upload";
import { UploadStatus, type UploadFile } from "../types/upload";
import PercentDisplay from "./PercentDisplay";

interface ProgressCellProps {
  fileId: string;
  status: UploadFile["status"];
  /** 尚无实时进度时回退到持久化记录里的进度 */
  fallbackProgress: number;
}

/**
 * VU-41：进度订阅下沉到单元格。
 *
 * 旧实现把 progress/speed/eta 展开进 dataSource 的每条 record，导致任意一条
 * 进度消息都会重建整张表的数据源，TableRow 的 memo 被完全击穿。现在父组件
 * 只传稳定的文件引用，本组件按 fileId 精确订阅三张 map——只有数值真正变化的
 * 那个单元格会重渲染。
 */
const ProgressCell = React.memo(
  ({ fileId, status, fallbackProgress }: ProgressCellProps) => {
    const { progress, speed, eta } = useUploadStore(
      useShallow((state) => ({
        progress: state.progressMap[fileId] ?? fallbackProgress,
        speed: state.speedMap[fileId] ?? 0,
        eta: state.etaMap[fileId] ?? 0,
      }))
    );

    if (status === UploadStatus.DONE || status === UploadStatus.INSTANT) {
      return <PercentDisplay percent={100} status="success" />;
    }
    if (status === UploadStatus.ERROR) {
      return <PercentDisplay percent={progress} status="error" />;
    }
    if (status === UploadStatus.PAUSED) {
      return (
        <Tooltip title="已暂停，可点击「继续」从断点续传">
          <PercentDisplay percent={progress} status="normal" />
        </Tooltip>
      );
    }
    if (status === UploadStatus.UPLOADING) {
      return (
        <PercentDisplay
          percent={progress}
          status="active"
          speed={speed}
          eta={eta}
        />
      );
    }
    return <PercentDisplay percent={progress} status="normal" />;
  }
);

ProgressCell.displayName = "ProgressCell";

export default ProgressCell;
