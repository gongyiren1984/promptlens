import type { AnalyticsResult } from '@promptlens/contracts';
import { qk, useApiQuery } from '../../api/hooks';
import { Badge, Button, Card, ErrorNotice, Stat, formatDateTime } from '../../components/ui';
import { BarList, TrendChart } from '../../components/charts';
import { DataTable, type Column } from '../../components/table';
import { navigate, projectPath } from '../../app/router';
import type { RunSummary } from '@promptlens/contracts';

export function AnalyticsPage({ projectId }: { projectId: string }) {
  const analytics = useApiQuery<AnalyticsResult>(qk.analytics(projectId), (client) => client.get(`/v1/projects/${projectId}/analytics`, { query: { limit: 30 } }));

  if (analytics.isError) {
    return (
      <div className="page">
        <ErrorNotice error={analytics.error} onRetry={() => analytics.refetch()} />
      </div>
    );
  }
  if (!analytics.data) {
    return (
      <div className="page">
        <div className="row" style={{ justifyContent: 'center', padding: 40 }}>
          <span className="spinner" /> 正在聚合…
        </div>
      </div>
    );
  }

  const { runs, totals, failureReasons } = analytics.data;
  const columns: Array<Column<RunSummary>> = [
    { key: 'created', header: '时间', render: (run) => <span className="small">{formatDateTime(run.createdAt)}</span> },
    { key: 'status', header: '状态', render: (run) => <Badge tone={run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'error' : 'muted'}>{run.status}</Badge> },
    { key: 'score', header: '均值分', align: 'right', render: (run) => <span className="mono">{run.meanScore == null ? '—' : run.meanScore.toFixed(3)}</span> },
    { key: 'valid', header: '有效/总数', align: 'right', render: (run) => <span className="mono">{run.counts.outputValid}/{run.counts.total}</span> },
    { key: 'eligible', header: '可比较', align: 'right', render: (run) => <span className="mono">{run.counts.comparisonEligible}</span> },
    { key: 'fallback', header: '回退', align: 'right', render: (run) => <span className="mono">{run.counts.fallbackUsed}</span> },
  ];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>分析</h1>
          <div className="sub">按最近 {runs.length} 次运行聚合；图表与下方表格使用同一口径。</div>
        </div>
        <span className="spacer" />
        <Button onClick={() => analytics.refetch()} loading={analytics.isFetching}>
          刷新
        </Button>
      </header>

      <div className="grid cols-4">
        <Stat label="运行" value={totals.runs} />
        <Stat label="完成" value={totals.completed} hint={`有错误 ${totals.withErrors}`} tone="ok" />
        <Stat label="取消" value={totals.canceled} tone={totals.canceled ? 'warn' : undefined} />
        <Stat label="失败" value={totals.failed} tone={totals.failed ? 'error' : undefined} />
      </div>

      <div className="grid cols-2">
        <Card title="平均分趋势" subtitle="仅统计可比较 Trial 的 overallScore">
          <TrendChart
            title="运行平均分趋势"
            points={runs.map((run) => ({ label: `${formatDateTime(run.createdAt)}`, value: run.meanScore ?? null }))}
          />
          <div style={{ marginTop: 10 }}>
            <DataTable
              columns={[
                { key: 'time', header: '运行', render: (run: RunSummary) => <span className="small">{formatDateTime(run.createdAt)}</span> },
                { key: 'score', header: '均值', align: 'right', render: (run: RunSummary) => <span className="mono">{run.meanScore == null ? '—' : run.meanScore.toFixed(3)}</span> },
                { key: 'n', header: '可比较', align: 'right', render: (run: RunSummary) => run.counts.comparisonEligible },
              ]}
              rows={runs}
              rowKey={(run) => run.runId}
              maxHeight={240}
            />
          </div>
        </Card>

        <Card title="不可比原因分布" subtitle="来自 Trial 的三轴状态与回退标记">
          <BarList
            items={failureReasons.map((item) => ({ label: item.reason, value: item.count, display: String(item.count), tone: 'alt' }))}
            emptyText="没有不可比 Trial"
          />
        </Card>
      </div>

      <Card title="运行明细" flush>
        <DataTable columns={columns} rows={runs} rowKey={(run) => run.runId} onRowClick={(run) => navigate(projectPath(projectId, `/runs/${run.runId}`))} maxHeight={420} />
      </Card>
    </div>
  );
}
