import { Badge } from "../../../ui/primitives";
import { Tooltip } from "../../../ui/feedback";
import React, { useRef } from "react";
import {
  resolveNetworkBadgeInfo,
  type NetworkBadgeStatus,
} from "../../../shared/networkStrategy";

import { ByteConvert } from "../utils";

interface NetworkStatusBadgeProps {
  networkType: string;
  chunkSize: number;
  fileConcurrency: number;
  chunkConcurrency: number;
  isOffline: boolean;
  displayMode: "tooltip" | "direct";
}

// 创建一个包装Badge的组件
const BadgeWrapper = React.forwardRef<
  HTMLSpanElement,
  { status: NetworkBadgeStatus; text: string }
>((props, ref) => {
  return (
    <span ref={ref}>
      <Badge status={props.status} text={props.text} />
    </span>
  );
});

BadgeWrapper.displayName = "BadgeWrapper";

const NetworkStatusBadge: React.FC<NetworkStatusBadgeProps> = ({
  networkType,
  chunkSize,
  fileConcurrency,
  chunkConcurrency,
  isOffline,
  displayMode = "tooltip",
}) => {
  // 创建一个引用
  const badgeRef = useRef<HTMLSpanElement>(null);

  const networkInfo = resolveNetworkBadgeInfo(networkType, isOffline);

  // 网络参数详情
  const networkDetails = (
    <>
      <div>网络类型: {networkInfo.text}</div>
      <div>分片大小: {ByteConvert(chunkSize)}</div>
      <div>文件并发: {fileConcurrency}</div>
      <div>分片并发: {chunkConcurrency}</div>
    </>
  );

  // 根据显示模式决定如何展示
  if (displayMode === "direct") {
    return (
      <div style={{ display: "flex", alignItems: "center", fontSize: "12px" }}>
        <Badge status={networkInfo.status} text={networkInfo.text} />
        <span style={{ marginLeft: 8 }}>
          {ByteConvert(chunkSize)} | {fileConcurrency}文件 | {chunkConcurrency}
          分片
        </span>
      </div>
    );
  }

  return (
    <>
      <Tooltip
        title={networkDetails}
        placement="bottom"
        getPopupContainer={() => document.body}
      >
        <BadgeWrapper
          ref={badgeRef}
          status={networkInfo.status}
          text={networkInfo.text}
        />
      </Tooltip>
    </>
  );
};

export default NetworkStatusBadge;
