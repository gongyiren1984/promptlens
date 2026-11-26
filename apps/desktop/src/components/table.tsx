import { useMemo, useRef, useState, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
  width?: number | string;
  sortValue?: (row: T) => string | number;
}

interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  emptyText?: ReactNode;
  maxHeight?: number;
  rowHeight?: number;
  virtualizeThreshold?: number;
}

/**
 * 数据表：表头吸顶、可排序、超过阈值时按视口渲染。
 * 只做视觉窗口化，DOM 行数受控，避免 1 万行阻塞主线程。
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  emptyText = '暂无数据',
  maxHeight = 540,
  rowHeight = 37,
  virtualizeThreshold = 120,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((item) => item.key === sort.key);
    if (!column?.sortValue) return rows;
    return [...rows].sort((a, b) => {
      const left = column.sortValue!(a);
      const right = column.sortValue!(b);
      if (left === right) return 0;
      return (left > right ? 1 : -1) * sort.dir;
    });
  }, [rows, sort, columns]);

  const virtual = sorted.length > virtualizeThreshold;
  const visible = useMemo(() => {
    if (!virtual) return sorted;
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 6);
    const end = start + Math.ceil(maxHeight / rowHeight) + 12;
    return sorted.slice(start, end);
  }, [sorted, virtual, scrollTop, rowHeight, maxHeight]);
  const offset = virtual ? Math.max(0, Math.floor(scrollTop / rowHeight) - 6) : 0;
  const topPad = virtual ? offset * rowHeight : 0;
  const bottomPad = virtual ? Math.max(0, (sorted.length - offset - visible.length) * rowHeight) : 0;

  if (!rows.length) {
    return <div className="table-empty">{emptyText}</div>;
  }

  return (
    <div
      className="table-wrap"
      style={{ maxHeight }}
      ref={containerRef}
      onScroll={(event) => {
        if (virtual) setScrollTop((event.target as HTMLDivElement).scrollTop);
      }}
    >
      <table className="data">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={column.align === 'right' ? 'num' : undefined}
                style={{ width: column.width }}
                aria-sort={sort?.key === column.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
              >
                {column.sortValue ? (
                  <button
                    type="button"
                    className="btn ghost small"
                    style={{ padding: 0, fontWeight: 600, color: 'inherit' }}
                    onClick={() =>
                      setSort((current) =>
                        current?.key === column.key ? { key: column.key, dir: current.dir === 1 ? -1 : 1 } : { key: column.key, dir: 1 },
                      )
                    }
                  >
                    {column.header}
                    {sort?.key === column.key ? <span>{sort.dir === 1 ? ' ▲' : ' ▼'}</span> : null}
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {topPad > 0 ? (
            <tr aria-hidden>
              <td colSpan={columns.length} style={{ height: topPad, padding: 0, border: 0 }} />
            </tr>
          ) : null}
          {visible.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                className={`${onRowClick ? 'clickable' : ''} ${selectedKey === key ? 'selected' : ''}`}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
              >
                {columns.map((column) => (
                  <td key={column.key} className={column.align === 'right' ? 'num' : undefined}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
          {bottomPad > 0 ? (
            <tr aria-hidden>
              <td colSpan={columns.length} style={{ height: bottomPad, padding: 0, border: 0 }} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
