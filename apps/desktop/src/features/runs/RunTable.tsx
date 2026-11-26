import type { RunSummary } from '@promptlens/contracts';
import { DataTable, type Column } from '../../components/table';
import { Badge, IdText, RunStatusBadge, formatAmountValue, formatDateTime, formatDuration } from '../../components/ui';
import { navigate, projectPath } from '../../app/router';

export function RunTable({ projectId, runs, maxHeight }: { projectId: string; runs: RunSummary[]; maxHeight?: number }) {
  const columns: Array<Column<RunSummary>> = [
    {
      key: 'status',
      header: '状态',
      render: (run) => <RunStatusBadge status={run.status} />,
      sortValue: (run) => run.status,
    },
    {
      key: 'runId',
      header: '运行',
      render: (run) => (
        <span className="stack" style={{ gap: 1 }}>
          <IdText value={run.runId} chars={12} />
          {run.parentRunId ? <span className="small dim">重试自 <IdText value={run.parentRunId} chars={8} /></span> : null}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: '创建时间',
      render: (run) => <span className="small">{formatDateTime(run.createdAt)}</span>,
      sortValue: (run) => run.createdAt,
    },
    {
      key: 'progress',
      header: 'Trial（完成/失败/取消）',
      render: (run) => (
        <span className="mono small">
          {run.counts.completed}/{run.counts.failed}/{run.counts.canceled}
          <span className="dim"> · 共 {run.counts.total}</span>
        </span>
      ),
      sortValue: (run) => run.counts.total,
    },
    {
      key: 'valid',
      header: '有效输出',
      align: 'right',
      render: (run) => <span className="mono">{run.counts.total ? `${run.counts.outputValid}/${run.counts.total}` : '—'}</span>,
      sortValue: (run) => (run.counts.total ? run.counts.outputValid / run.counts.total : 0),
    },
    {
      key: 'eligible',
      header: '可比较',
      align: 'right',
      render: (run) => <span className="mono">{run.counts.comparisonEligible}</span>,
      sortValue: (run) => run.counts.comparisonEligible,
    },
    {
      key: 'fallback',
      header: '回退',
      align: 'right',
      render: (run) => run.counts.fallbackUsed ? <Badge tone="warn">{run.counts.fallbackUsed}</Badge> : <span className="dim">0</span>,
      sortValue: (run) => run.counts.fallbackUsed,
    },
    {
      key: 'score',
      header: '均值分',
      align: 'right',
      render: (run) => <span className="mono">{run.meanScore == null ? '—' : run.meanScore.toFixed(3)}</span>,
      sortValue: (run) => run.meanScore ?? -1,
    },
    {
      key: 'cost',
      header: '成本',
      align: 'right',
      render: (run) =>
        run.cost ? (
          <span className="mono small" title={run.cost.complete ? '价格完整' : '包含未知价格，合计不完整'}>
            {formatAmountValue(run.cost.amount, null, run.cost.complete)}
            {run.cost.unknownCount ? <span className="dim"> ？{run.cost.unknownCount}</span> : null}
          </span>
        ) : (
          <span className="dim">—</span>
        ),
      sortValue: (run) => Number(run.cost?.amount ?? 0),
    },
    {
      key: 'duration',
      header: '耗时',
      align: 'right',
      render: (run) => <span className="mono small">{formatDuration(run.startedAt, run.finishedAt)}</span>,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={runs}
      rowKey={(run) => run.runId}
      onRowClick={(run) => navigate(projectPath(projectId, `/runs/${run.runId}`))}
      emptyText="还没有运行记录。"
      maxHeight={maxHeight}
    />
  );
}
