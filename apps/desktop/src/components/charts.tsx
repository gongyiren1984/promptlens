import type { ReactNode } from 'react';

export interface BarItem {
  label: ReactNode;
  value: number;
  display?: ReactNode;
  tone?: 'default' | 'alt';
}

export function BarList({ items, max, emptyText = '暂无数据' }: { items: BarItem[]; max?: number; emptyText?: string }) {
  if (!items.length) return <div className="table-empty">{emptyText}</div>;
  const ceiling = max ?? Math.max(...items.map((item) => item.value), 0.0001);
  return (
    <div className="stack" style={{ gap: 2 }}>
      {items.map((item, index) => (
        <div className="bar-row" key={index}>
          <span className="truncate" title={typeof item.label === 'string' ? item.label : undefined}>
            {item.label}
          </span>
          <span className="bar-track">
            <span
              className={`bar-fill ${item.tone === 'alt' ? 'alt' : ''}`}
              style={{ width: `${Math.max(1, Math.min(100, (item.value / ceiling) * 100))}%` }}
            />
          </span>
          <span className="mono" style={{ textAlign: 'right' }}>
            {item.display ?? item.value.toFixed(3)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function TrendChart({
  points,
  height = 150,
  title,
  valueLabel = '数值',
}: {
  points: Array<{ label: string; value: number | null; hint?: string }>;
  height?: number;
  title: string;
  valueLabel?: string;
}) {
  const usable = points.map((point, index) => ({ ...point, index })).filter((point) => point.value !== null) as Array<{
    label: string;
    value: number;
    hint?: string;
    index: number;
  }>;
  if (usable.length < 2) return <div className="table-empty">至少需要两次运行才能绘制趋势</div>;
  const width = 640;
  const padX = 34;
  const padY = 18;
  const values = usable.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (index: number) => padX + (index / (points.length - 1)) * (width - padX * 2);
  const y = (value: number) => padY + (1 - (value - min) / span) * (height - padY * 2);
  const path = usable.map((point) => `${x(point.index)},${y(point.value)}`).join(' ');
  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}趋势图`}>
      <title>{title}</title>
      <desc>{`${valueLabel}趋势：${usable.map((point) => `${point.label} ${point.value}`).join('，')}`}</desc>
      {[0, 0.5, 1].map((ratio) => (
        <line
          key={ratio}
          x1={padX}
          x2={width - padX}
          y1={padY + ratio * (height - padY * 2)}
          y2={padY + ratio * (height - padY * 2)}
          stroke="var(--border)"
          strokeDasharray="3 4"
        />
      ))}
      <polyline points={path} fill="none" stroke="var(--cyan)" strokeWidth="2" strokeLinejoin="round" />
      {usable.map((point) => (
        <circle key={point.index} cx={x(point.index)} cy={y(point.value)} r="3" fill="var(--accent)">
          <title>{`${point.label}: ${point.value.toFixed(3)}`}</title>
        </circle>
      ))}
      <text x={padX} y={12} fill="var(--muted)" fontSize="10">
        {max.toFixed(3)}
      </text>
      <text x={padX} y={height - 4} fill="var(--muted)" fontSize="10">
        {min.toFixed(3)}
      </text>
    </svg>
  );
}
