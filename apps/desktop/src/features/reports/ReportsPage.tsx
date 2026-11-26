import { useState } from 'react';
import type { ReportDetail, ReportRecord, RunSummary } from '@promptlens/contracts';
import { getClient } from '../../api/bridge';
import { qk, useApiMutation, useApiQuery, useQueryInvalidator } from '../../api/hooks';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorNotice,
  Field,
  IdText,
  Modal,
  Select,
  formatDateTime,
  useToast,
} from '../../components/ui';
import { DataTable, type Column } from '../../components/table';
import { Markdown } from '../../components/markdown';
import { navigate, projectPath } from '../../app/router';

export function ReportsPage({ projectId }: { projectId: string }) {
  const { push } = useToast();
  const invalidate = useQueryInvalidator();
  const reports = useApiQuery<{ reports: ReportRecord[] }>(qk.reports(projectId), (client) => client.get(`/v1/projects/${projectId}/reports`));
  const runs = useApiQuery<{ runs: RunSummary[] }>(qk.runs(projectId, '', 0), (client) =>
    client.get(`/v1/projects/${projectId}/runs`, { query: { limit: 50 } }),
  );
  const [generateOpen, setGenerateOpen] = useState(false);
  const [runId, setRunId] = useState('');
  const [preview, setPreview] = useState<ReportDetail | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const generate = useApiMutation(
    (client, value: { runId: string }) => client.post<ReportRecord>(`/v1/projects/${projectId}/reports`, value),
    {
      invalidate: () => [qk.reports(projectId)],
      onSuccess: async (report) => {
        setGenerateOpen(false);
        push('报告已生成', 'success');
        await invalidate(qk.reports(projectId));
        await openReport(report.reportId);
      },
      onError: (error) => push((error as Error).message, 'error'),
    },
  );

  async function openReport(reportId: string) {
    setLoadingPreview(true);
    try {
      const client = await getClient();
      const detail = await client.get<ReportDetail>(`/v1/projects/${projectId}/reports/${reportId}`);
      setPreview(detail);
    } catch (error) {
      push((error as Error).message, 'error');
    } finally {
      setLoadingPreview(false);
    }
  }

  function download(markdown: string, name: string) {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${name}.md`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const columns: Array<Column<ReportRecord>> = [
    { key: 'id', header: '报告', render: (report) => <IdText value={report.reportId} chars={12} /> },
    {
      key: 'run',
      header: '运行',
      render: (report) => (
        <button className="btn ghost small mono" onClick={() => navigate(projectPath(projectId, `/runs/${report.runId}`))}>
          {report.runId.slice(0, 12)}…
        </button>
      ),
    },
    { key: 'time', header: '生成时间', render: (report) => <span className="small">{formatDateTime(report.generatedAt)}</span> },
    { key: 'status', header: '状态', render: (report) => <Badge tone={report.status === 'complete' ? 'ok' : 'warn'}>{report.status}</Badge> },
    { key: 'evidence', header: '证据状态', render: (report) => <span className="small dim">{report.evidenceState ?? '—'}</span> },
    { key: 'hash', header: '内容哈希', render: (report) => <span className="mono small dim">{report.contentHash ? `${report.contentHash.slice(0, 16)}…` : '—'}</span> },
    {
      key: 'actions',
      header: '',
      render: (report) => (
        <Button size="small" onClick={() => openReport(report.reportId)}>
          预览
        </Button>
      ),
    },
  ];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>报告</h1>
          <div className="sub">报告按运行归档，版本不可变；重生成会创建新版本并保留旧文件。</div>
        </div>
        <span className="spacer" />
        <div className="sticky-actions">
          <Button variant="primary" onClick={() => setGenerateOpen(true)}>
            生成报告
          </Button>
        </div>
      </header>

      {reports.isError ? <ErrorNotice error={reports.error} onRetry={() => reports.refetch()} /> : null}

      <Card flush>
        {reports.data && !reports.data.reports.length ? (
          <EmptyState title="还没有报告" description="运行结束后生成 Markdown 报告，包含 9 个必备章节。" action={<Button variant="primary" onClick={() => setGenerateOpen(true)}>生成第一份报告</Button>} />
        ) : (
          <DataTable columns={columns} rows={reports.data?.reports ?? []} rowKey={(report) => report.reportId} maxHeight={520} emptyText="加载中…" />
        )}
      </Card>

      <Modal
        open={generateOpen}
        title="生成报告"
        onClose={() => setGenerateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setGenerateOpen(false)}>取消</Button>
            <Button variant="primary" loading={generate.isPending} disabled={!runId} onClick={() => generate.mutate({ runId })}>
              生成
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="选择运行" hint="仅已结束的运行可生成报告。">
            <Select value={runId} onChange={(event) => setRunId(event.target.value)}>
              <option value="">请选择</option>
              {(runs.data?.runs ?? []).map((run) => (
                <option key={run.runId} value={run.runId}>
                  {run.runId.slice(0, 12)}… · {formatDateTime(run.createdAt)} · {run.status}
                </option>
              ))}
            </Select>
          </Field>
          <div className="small dim">报告包含运行摘要、实验快照、评估方法、分维度结果、逐用例证据、失败与无效输出、成本与耗时、不确定性、限制与建议。</div>
          {generate.error ? <ErrorNotice error={generate.error} /> : null}
        </div>
      </Modal>

      <Modal
        open={Boolean(preview)}
        wide
        title={preview ? `报告 ${preview.report.reportId.slice(0, 12)}…` : '报告预览'}
        onClose={() => setPreview(null)}
        footer={
          <>
            {preview?.markdown ? <CopyButton value={preview.markdown} label="复制 Markdown" /> : null}
            {preview?.markdown ? (
              <Button onClick={() => download(preview.markdown!, preview.report.reportId)}>下载 .md</Button>
            ) : null}
            {preview ? (
              <Button
                loading={generate.isPending}
                onClick={() => generate.mutate({ runId: preview.report.runId })}
                title="按当前模板重建，产生新版本"
              >
                按新模板重生成
              </Button>
            ) : null}
            <Button variant="primary" onClick={() => setPreview(null)}>
              关闭
            </Button>
          </>
        }
      >
        {loadingPreview ? (
          <div className="row" style={{ justifyContent: 'center', padding: 30 }}>
            <span className="spinner" /> 加载正文…
          </div>
        ) : preview ? (
          <div className="stack">
            <div className="row small dim">
              <span>运行 {preview.report.runId}</span>
              <span>模板 {preview.report.templateVersionId}</span>
              <span>哈希 {preview.report.contentHash?.slice(0, 22)}…</span>
              {preview.report.redactions?.length ? <Badge tone="warn">已脱敏 {preview.report.redactions.length}</Badge> : null}
            </div>
            {preview.report.warnings?.length ? (
              <div className="notice warn">
                {preview.report.warnings.map((warning) => (
                  <div key={warning.code}>{warning.message}</div>
                ))}
              </div>
            ) : null}
            {preview.markdown ? <Markdown text={preview.markdown} /> : <div className="dim">正文不可用</div>}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
