/**
 * rui-ui Table（精减模式）——只实现调用点用到的能力：
 *
 * - columns: { title, dataIndex, key, render, ellipsis, align, width }
 * - dataSource / rowKey / pagination={false}（不分页是调用点统一形态）
 * - loading（半透明遮罩 + 自旋）/ size（middle|small）
 * - bordered / scroll={{ x }}（横向滚动容器）/ locale.emptyText
 * - rowSelection: { selectedRowKeys, onChange, getCheckboxProps }
 */
import React from "react";
import { Empty, Spin } from "./primitives";

export interface ColumnType<RecordType> {
  title: React.ReactNode;
  dataIndex?: string;
  key?: string;
  /**
   * render 首参类型用 unknown（调用点通过 record[dataIndex] 自行收窄），
   * 既不引入 any，也让业务侧以 (value: unknown, record) => ... 形式接收。
   */
  render?: (value: unknown, record: RecordType, index: number) => React.ReactNode;
  /** 超长省略（配合原生 title 悬停全显） */
  ellipsis?: boolean;
  align?: "left" | "center" | "right";
  width?: number | string;
}

export interface RowSelection<RecordType> {
  selectedRowKeys: React.Key[];
  onChange: (selectedKeys: React.Key[]) => void;
  getCheckboxProps?: (record: RecordType) => { disabled?: boolean };
}

export interface TableProps<RecordType extends object> {
  columns: ColumnType<RecordType>[];
  dataSource: RecordType[];
  rowKey?: string;
  pagination?: false;
  loading?: boolean;
  size?: "small" | "middle" | "large";
  bordered?: boolean;
  scroll?: { x?: number | string };
  locale?: { emptyText?: React.ReactNode };
  rowSelection?: RowSelection<RecordType>;
  style?: React.CSSProperties;
}

/**
 * 单列表行：用 React.memo 包裹，使父级（FileList / FileTable）因无关状态
 * （切换 showXxx 开关、storageUsage 变化等）重渲染时，未变化的行跳过 Diff。
 *
 * VU-41：FileTable 现在直接传 store 中的稳定文件引用（不再展开
 * progress/speed/eta 生成新 record），且 columns 只在低频状态变化时重建，
 * 因此默认的浅比较就能真正命中：一次进度更新只重渲染对应行的 ProgressCell。
 * 这里不再加自定义比较器——columns 变化本来就要求行重新 render。
 */
interface TableRowProps<RecordType> {
  record: RecordType;
  columns: ColumnType<RecordType>[];
  rowKey: string;
  rowIndex: number;
  hasRowSelection: boolean;
  checked: boolean;
  disabled: boolean;
  onToggleOne?: (key: React.Key) => void;
}

function TableRowInner<RecordType extends object>({
  record,
  columns,
  rowKey,
  rowIndex,
  hasRowSelection,
  checked,
  disabled,
  onToggleOne,
}: TableRowProps<RecordType>) {
  // VU-41：长列表跳过视口外行的布局与绘制，intrinsic size 避免滚动条抖动。
  return (
    <tr
      className="rui-table-row"
      style={{
        contentVisibility: "auto",
        containIntrinsicSize: "auto 48px",
      }}
    >
      {hasRowSelection && (
        <td>
          <input
            type="checkbox"
            className="rui-table-checkbox"
            checked={checked}
            disabled={disabled}
            onChange={() => onToggleOne?.(getKey(record, rowKey, rowIndex))}
            aria-label="select row"
          />
        </td>
      )}
      {columns.map((col, colIndex) => {
        const value = col.dataIndex
          ? (record as Record<string, unknown>)[col.dataIndex]
          : undefined;
        const content = col.render
          ? col.render(value, record, rowIndex)
          : (value as React.ReactNode);
        return (
          <td
            key={col.key ?? String(col.dataIndex ?? colIndex)}
            className={col.ellipsis ? "rui-table-ellipsis" : undefined}
            title={
              col.ellipsis && typeof content === "string"
                ? content
                : undefined
            }
            style={{ textAlign: col.align }}
          >
            {content}
          </td>
        );
      })}
    </tr>
  );
}

const TableRow = React.memo(TableRowInner) as typeof TableRowInner;

export function Table<RecordType extends object>({
  columns,
  dataSource,
  rowKey = "key",
  loading,
  size,
  bordered,
  scroll,
  locale,
  rowSelection,
  style,
}: TableProps<RecordType>) {
  const allKeys = React.useMemo(
    () => dataSource.map((record, index) => getKey(record, rowKey, index)),
    [dataSource, rowKey],
  );

  const selectableKeys = React.useMemo(() => {
    if (!rowSelection?.getCheckboxProps) return allKeys;
    return allKeys.filter((_key, i) => {
      const record = dataSource[i];
      return !(record && rowSelection.getCheckboxProps!(record).disabled);
    });
  }, [allKeys, dataSource, rowSelection]);

  const selectedSet = React.useMemo(
    () => new Set(rowSelection?.selectedRowKeys ?? []),
    [rowSelection],
  );

  const allChecked =
    selectableKeys.length > 0 &&
    selectableKeys.every((k) => selectedSet.has(k));
  const someChecked =
    !allChecked && selectableKeys.some((k) => selectedSet.has(k));

  const toggleAll = React.useCallback(() => {
    if (!rowSelection) return;
    if (allChecked) {
      rowSelection.onChange(
        rowSelection.selectedRowKeys.filter(
          (k) => !selectableKeys.includes(k),
        ),
      );
    } else {
      const merged = new Set([...rowSelection.selectedRowKeys, ...selectableKeys]);
      rowSelection.onChange([...merged]);
    }
  }, [rowSelection, selectableKeys, allChecked]);

  const toggleOne = React.useCallback(
    (key: React.Key) => {
      if (!rowSelection) return;
      const next = selectedSet.has(key)
        ? rowSelection.selectedRowKeys.filter((k) => k !== key)
        : [...rowSelection.selectedRowKeys, key];
      rowSelection.onChange(next);
    },
    [rowSelection, selectedSet],
  );

  const table = (
    <table
      className={[
        "rui-table",
        bordered ? "rui-table-bordered" : "",
        size === "small" ? "rui-table-small" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
    >
      <thead>
        <tr>
          {rowSelection && (
            <th style={{ width: 40 }}>
              <input
                type="checkbox"
                className="rui-table-checkbox"
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = someChecked;
                }}
                onChange={toggleAll}
                aria-label="select all"
              />
            </th>
          )}
          {columns.map((col, i) => (
            <th
              key={col.key ?? String(col.dataIndex ?? i)}
              style={{
                width: col.width,
                textAlign: col.align,
              }}
            >
              {col.title}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {dataSource.map((record, rowIndex) => {
          const key = getKey(record, rowKey, rowIndex);
          const disabled = rowSelection?.getCheckboxProps?.(record).disabled;
          return (
            <TableRow<RecordType>
              key={key}
              record={record}
              columns={columns}
              rowKey={rowKey}
              rowIndex={rowIndex}
              hasRowSelection={!!rowSelection}
              checked={rowSelection ? selectedSet.has(key) : false}
              disabled={!!disabled}
              onToggleOne={rowSelection ? toggleOne : undefined}
            />
          );
        })}
      </tbody>
    </table>
  );

  const emptyText = locale?.emptyText ?? <Empty />;

  return (
    <div className={`rui-table-wrap${loading ? " rui-table-loading" : ""}`}>
      {scroll?.x !== undefined ? (
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: scroll.x }}>{table}</div>
        </div>
      ) : (
        table
      )}
      {loading && (
        <div className="rui-spin-nested">
          <Spin />
        </div>
      )}
      {!loading && dataSource.length === 0 && (
        <div className="rui-table-empty">{emptyText}</div>
      )}
    </div>
  );
}

function getKey(record: unknown, rowKey: string, index: number): React.Key {
  if (
    typeof rowKey === "string" &&
    record !== null &&
    typeof record === "object" &&
    rowKey in record
  ) {
    const v = (record as Record<string, unknown>)[rowKey];
    if (v !== undefined && v !== null) return v as React.Key;
  }
  return index;
}
