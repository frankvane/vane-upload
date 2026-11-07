/**
 * rui-ui —— 组件库内置极简 UI 套件（替代 antd）。
 *
 * 导出面与调用点对齐：精减模式下不提供 antd 全量组件，
 * 只保留 src 实际使用的 19 类组件 + 19 个图标。
 */

// 样式随组件走：任何模块引入本目录组件都会带上 ui.css。
// （此前仅由 src/index.ts 引入，导致 demo/dev 直接引组件时整页裸奔——
//  rui-* 类全部无样式、空态 SVG 撑满容器。lib 构建下同一文件去重，
//  仍只产出一份 dist/style.css，不影响消费方。）
import "./ui.css";

export { Button } from "./primitives";
export type { ButtonProps } from "./primitives";
export { Tag } from "./primitives";
export type { TagProps, TagColor } from "./primitives";
export { Badge } from "./primitives";
export type { BadgeProps, BadgeStatus } from "./primitives";
export { Spin } from "./primitives";
export type { SpinProps } from "./primitives";
export { Empty } from "./primitives";
export { Divider } from "./primitives";
export { Card } from "./primitives";
export type { CardProps } from "./primitives";
export { Space } from "./primitives";
export type { SpaceProps } from "./primitives";
export { Alert } from "./primitives";
export type { AlertProps } from "./primitives";
export { Statistic } from "./primitives";
export type { StatisticProps } from "./primitives";
export { Progress } from "./primitives";
export type { ProgressProps } from "./primitives";
export { Switch } from "./primitives";
export type { SwitchProps } from "./primitives";
export { InputNumber } from "./primitives";
export type { InputNumberProps } from "./primitives";
export { Slider } from "./primitives";
export type { SliderProps } from "./primitives";

export { Typography } from "./typography";
export { Row, Col } from "./typography";
export type { RowProps, ColProps } from "./typography";

export { Tooltip, Popconfirm, Modal, confirm, Drawer } from "./feedback";
export type {
  TooltipProps,
  PopconfirmProps,
  ModalProps,
  ConfirmOptions,
  DrawerProps,
} from "./feedback";

export { Collapse } from "./collapse";
export type { CollapseProps, CollapseItem } from "./collapse";

export { Table } from "./table";
export type { TableProps, ColumnType, RowSelection } from "./table";

export { message } from "./message";
export type { MessageInstance, MessageType } from "./message";

export { ErrorBoundary } from "./ErrorBoundary";
export type { ErrorBoundaryProps } from "./ErrorBoundary";

export * from "./icons";
export type { IconProps } from "./icons";
