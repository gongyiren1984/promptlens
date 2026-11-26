import { useState } from 'react';
import type { RunSummary } from '@promptlens/contracts';
import { qk, useApiQuery } from '../../api/hooks';
import { Button, Card, ErrorNotice, Input, Select, formatDateTime } from '../../components/ui';
import { RunTable } from './RunTable';

const PAGE_SIZE = 20;

export function RunsPage({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);
  const [runId, setRunId] = useState('');

  const runs = useApiQuery<{ total: number; runs: RunSummary[] }>(
    qk.runs(projectId, status, page, `${from}~${to}`),
    (client) =>
      client.get(`/v1/projects/${projectId}/runs`, {
        query: { status: status || undefined, from: from || undefined, to: to || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE },
      }),
    { refetchInterval: 8_000 },
  );

  const totalPages = runs.data ? Math.max(1, Math.ceil(runs.data.total / PAGE_SIZE)) : 1;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>运行历史</h1>
          <div className="sub">三轴状态分别记录执行、输出有效性与评估结果；成本未知不会按 0 计。</div>
        </div>
        <span className="spacer" />
        <div className="sticky-actions">
          <Input placeholder="按运行 ID 进入" value={runId} onChange={(event) => setRunId(event.target.value.trim())} style={{ width: 240 }} className="mono" />
          <Button onClick={() => runId && (window.location.hash = `#/projects/${projectId}/runs/${runId}`)} disabled={!runId}>
            打开
          </Button>
        </div>
      </header>

      <div className="toolbar">
        <Select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(0);
          }}
        >
          <option value="">全部状态</option>
          <option value="queued">排队中</option>
          <option value="running">执行中</option>
          <option value="completed">已完成</option>
          <option value="completed_with_errors">完成但有错误</option>
          <option value="canceled">已取消</option>
          <option value="failed">失败</option>
        </Select>
        <Input
          type="date"
          value={from}
          onChange={(event) => {
            setFrom(event.target.value);
            setPage(0);
          }}
          style={{ width: 150 }}
          aria-label="起始日期"
        />
        <span className="small dim">至</span>
        <Input
          type="date"
          value={to}
          onChange={(event) => {
            setTo(event.target.value);
            setPage(0);
          }}
          style={{ width: 150 }}
          aria-label="结束日期"
        />
        {from || to ? (
          <Button
            size="small"
            variant="ghost"
            onClick={() => {
              setFrom('');
              setTo('');
              setPage(0);
            }}
          >
            清除日期
          </Button>
        ) : null}
        <span className="spacer" />
        <span className="small dim">{runs.data ? `共 ${runs.data.total} 次运行` : ''}</span>
        <Button size="small" onClick={() => runs.refetch()} loading={runs.isFetching}>
          刷新
        </Button>
      </div>

      {runs.isError ? <ErrorNotice error={runs.error} onRetry={() => runs.refetch()} /> : null}

      <Card flush>
        <RunTable projectId={projectId} runs={runs.data?.runs ?? []} maxHeight={560} />
        <div className="row" style={{ padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
          <Button size="small" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>
            上一页
          </Button>
          <span className="small dim">
            第 {page + 1} / {totalPages} 页 · 更新时间 {formatDateTime(new Date().toISOString())}
          </span>
          <Button size="small" disabled={page + 1 >= totalPages} onClick={() => setPage((value) => value + 1)}>
            下一页
          </Button>
        </div>
      </Card>
    </div>
  );
}
