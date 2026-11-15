import React from "react";
import { useShallow } from "zustand/react/shallow";

import { useUploadStore } from "../store/upload";
import { UploadStatus } from "../types/upload";

/**
 * 极简模式（uiMode="minimal"）专用的「分段聚合进度细线」。
 *
 * 与旧版（单色 + status 决定整条颜色）的区别：
 * - 旧版只要有一个文件失败就把整条染红，连已完成部分也被盖住，视觉上
 *   变成「传了一大半却全红」的矛盾信号。
 * - 新版把整条线按字节占比切成若干段，各段按文件状态着色：
 *   绿=已完成、红=失败文件整段、蓝=进行中文件已传部分、灰=未传部分。
 *   失败只占属于它自己的那一小段，不再污染已完成区域。
 *
 * 宽度由父容器（FileUploadActions 里包住「选择文件」按钮的 inline-flex
 * column）决定，本组件 width:100% 因此与按钮等宽、不越过按钮；高度 4px，
 * 紧贴按钮下方，比旧版 6px 更省空间。
 *
 * 性能：selector 返回 5 个标量（percent/success/exception/active/count），
 * useShallow 只在数值真正变化时才重渲染，不触碰按钮与表格。
 */
interface AggregateSegments {
  percent: number;
  success: number;
  exception: number;
  active: number;
  count: number;
}

const useAggregateProgress = () =>
  useUploadStore(
    useShallow((state): AggregateSegments => {
      const files = state.files;
      if (files.length === 0) {
        return { percent: 0, success: 0, exception: 0, active: 0, count: 0 };
      }

      // 第一遍：总字节。全 0 字节（含无 fileSize 的桩数据）时按文件数退化。
      let totalSize = 0;
      for (const file of files) totalSize += Math.max(file.fileSize, 0);
      const allZero = totalSize === 0;
      const denom = allZero ? files.length : totalSize;

      let weighted = 0;
      let doneBytes = 0;
      let errorBytes = 0;
      let activeDoneBytes = 0;

      for (const file of files) {
        const size = allZero ? 1 : Math.max(file.fileSize, 0);
        const isDone =
          file.status === UploadStatus.DONE || file.status === UploadStatus.INSTANT;
        const isError = file.status === UploadStatus.ERROR;
        const raw = state.progressMap[file.id] ?? file.progress ?? 0;
        const progress = isDone ? 100 : Math.max(0, Math.min(100, raw));

        weighted += size * progress;
        if (isDone) {
          doneBytes += size;
        } else if (isError) {
          // 失败文件整段染红（按其体积占比），不按最后进度，保证失败信号可见。
          errorBytes += size;
        } else {
          // 进行中只把「已传部分」染蓝，剩余自然留灰。
          // progress 是 0-100 量纲，先归一成比例再乘字节，否则宽度会放大 100 倍。
          activeDoneBytes += (size * progress) / 100;
        }
      }

      return {
        percent: Math.round(weighted / denom),
        success: (doneBytes / denom) * 100,
        exception: (errorBytes / denom) * 100,
        active: (activeDoneBytes / denom) * 100,
        count: files.length,
      };
    })
  );

const MinimalProgressLine: React.FC = () => {
  const { percent, success, exception, active, count } = useAggregateProgress();
  if (count === 0) return null;

  const segments: Array<{ key: string; value: number; color: string }> = [
    { key: "success", value: success, color: "var(--rui-success)" },
    { key: "exception", value: exception, color: "var(--rui-danger)" },
    { key: "active", value: active, color: "var(--rui-brand)" },
  ];

  return (
    <div
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="上传进度"
      style={{
        width: "100%",
        height: 4,
        display: "flex",
        borderRadius: 100,
        overflow: "hidden",
        background: "var(--rui-border)",
        marginTop: 4,
      }}
    >
      {segments.map(
        (seg) =>
          seg.value > 0 && (
            <div
              key={seg.key}
              data-status={seg.key}
              style={{ width: `${seg.value}%`, background: seg.color, height: "100%" }}
            />
          )
      )}
    </div>
  );
};

export default MinimalProgressLine;
