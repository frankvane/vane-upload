/**
 * rui-ui —— 组件库内置极简 UI 套件（替代 antd）的**对外公共 API**。
 *
 * VU-46：本文件不再带任何 CSS 副作用，也不再用 `export *`。
 * 库内部组件一律从具体模块具名导入（例如 `./primitives`、`./table`），
 * 避免任何一处 `import { X } from "../../../ui"` 就把 primitives /
 * feedback / table / icons 全量拖进产物。样式由两个入口各引入一次：
 * 应用入口 `src/main.tsx` 与库入口 `src/index.ts`。
 */

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

// 显式具名导出（不再 `export *`），让消费方打包器能精确 tree-shake 单个图标。
export {
  BarChartOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  ExportOutlined,
  InfoCircleOutlined,
  LockOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SettingOutlined,
  SwapOutlined,
  UnlockOutlined,
  UploadOutlined,
  WarningOutlined,
} from "./icons";
export type { IconProps, IconName } from "./icons";
