import { useEffect, useMemo, useRef, useState } from 'react';
import type { EvaluationRecord, RunBundle, RunCostSummary, RunEvent, Trial, TrialOutput } from '@promptlens/contracts';
import { getClient } from '../../api/bridge';
import { qk, useApiMutation, useApiQuery } from '../../api/hooks';
import { streamRunEvents } from '@promptlens/api-client';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  Drawer,
  ErrorNotice,
  EvaluationBadge,
  IdText,
  RunStatusBadge,
  Select,
  Stat,
  Tabs,
  TrialStatusBadge,
  ValidityBadge,
  formatAmountValue,
  formatDateTime,
  formatDuration,
  useToast,
} from '../../components/ui';
import { DataTable, type Column } from '../../components/table';
import { navigate, projectPath } from '../../app/router';

const TERMINAL = new Set(['completed', 'completed_with_errors', 'canceled', 'failed']);

export function RunMonitorPage({ projectId, runId }: { projectId: string; runId: string }) {
  const { push } = useToast();
  const [tab, setTab] = useState<'trials' | 'events' | 'snapshot'>('trials');
  const [selected, setSelected] = useState<Trial | null>(null);
  const [liveEvents, setLiveEvents] = useState<RunEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const lastSeq = useRef(0);

  const bundle = useApiQuery<RunBundle>(
    qk.run(projectId, runId),
    (client) => client.get(`/v1/projects/${projectId}/runs/${runId}`, { query: { includeOutputs: 1, trialLimit: 2000 } }),
    { refetchInterval: 6_000 },
  );
  const cost = useApiQuery<RunCostSummary>(qk.runCost(projectId, runId), (client) => client.get(`/v1/projects/${projectId}/runs/${runId}/cost`), {
    refetchInterval: 6_000,
  });

  const status = bundle.data?.run.status ?? '';
  const active = status && !TERMINAL.has(status);

  useEffect(() => {
    setLiveEvents([]);
    lastSeq.current = 0;
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const client = await getClient();
      if (cancelled) return;
      dispose = streamRunEvents(client, {
        projectId,
        runId,
        afterSeq: 0,
        onEvent: (event) => {
          if (event.seq <= lastSeq.current) return;
          lastSeq.current = event.seq;
          setLiveEvents((current) => [...current.slice(-300), event]);
          if (event.type === 'run_finished' || event.type === 'run_failed' || event.type === 'evaluation_completed') {
            void bundle.refetch();
            void cost.refetch();
          }
        },
        onEnd: () => {
          setConnected(false);
          void bundle.refetch();
          void cost.refetch();
        },
        onError: () => setConnected(false),
      });
      setConnected(true);
    })();
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [projectId, runId]);

  const cancel = useApiMutation((client) => client.post(`/v1/projects/${projectId}/runs/${runId}/cancel`), {
    invalidate: () => [qk.run(projectId, runId), qk.runs(projectId, '', 0)],
    onSuccess: () => push('已请求停止：不再发起新请求，已完成 Trial 保留', 'warn'),
    onError: (error) => push((error as Error).message, 'error'),
  });

  const [stopModelId, setStopModelId] = useState('');
  const stopModel = useApiMutation<{ canceledTrials: number; remaining: number }, string>(
    (client, modelConfigVersionId) =>
      client.post(`/v1/projects/${projectId}/runs/${runId}/cancel`, { modelConfigVersionId }),
    {
      invalidate: () => [qk.run(projectId, runId), qk.runs(projectId, '', 0)],
      onSuccess: (result) => {
        setStopModelId('');
        push(`已停止该模型 ${result.canceledTrials} 个排队 Trial`, 'success', `仍有 ${result.remaining} 个 Trial 在执行其他模型`);
      },
      onError: (error) => push((error as Error).message, 'error'),
    },
  );

  const retry = useApiMutation(
    (client) => client.post<{ runId: string }>(`/v1/projects/${projectId}/runs/${runId}/retry-failed`),
    {
      invalidate: () => [qk.runs(projectId, '', 0)],
      onSuccess: (result) => {
        push('已派生重试运行', 'success');
        navigate(projectPath(projectId, `/runs/${result.runId}`));
      },
      onError: (error) => push((error as Error).message, 'error'),
    },
  );

  const evaluationByTrial = useMemo(() => {
    const map = new Map<string, EvaluationRecord>();
    for (const evaluation of bundle.data?.evaluations ?? []) map.set(evaluation.trialId, evaluation);
    return map;
  }, [bundle.data]);

  const events = useMemo(() => {
    const fromBundle = bundle.data?.events ?? [];
    const map = new Map<number, RunEvent>();
    for (const event of fromBundle) map.set(event.seq, event);
    for (const event of liveEvents) map.set(event.seq, event);
    return [...map.values()].sort((a, b) => b.seq - a.seq);
  }, [bundle.data, liveEvents]);

  if (bundle.isError) {
    return (
      <div className="page">
        <ErrorNotice error={bundle.error} onRetry={() => bundle.refetch()} />
      </div>
    );
  }
  if (!bundle.data) {
    return (
      <div className="page">
        <div className="row" style={{ justifyContent: 'center', padding: 40 }}>
          <span className="spinner" /> 加载运行…
        </div>
      </div>
    );
  }

  const { run, counts, labels, snapshotSummary } = bundle.data;
  const finished = counts.completed + counts.failed + counts.canceled;
  const evalCompleted = bundle.data.evaluations.filter((item) => item.overallScore != null).length;
  const outputInvalid = counts.outputInvalid;

  const trialColumns: Array<Column<Trial>> = [
    { key: 'status', header: '执行', render: (trial) => <TrialStatusBadge status={trial.trialStatus} />, sortValue: (trial) => trial.trialStatus },
    { key: 'validity', header: '输出', render: (trial) => <ValidityBadge validity={trial.outputValidity} /> },
    { key: 'eval', header: '评估', render: (trial) => <EvaluationBadge status={trial.evaluationStatus} /> },
    {
      key: 'branch',
      header: '分支 / 模型',
      render: (trial) => (
        <span>
          <Badge tone="accent">{labels.variants[trial.variantVersionId]?.label ?? '?'}</Badge>{' '}
          <span className="small">{labels.models[trial.modelConfigVersionId]?.name ?? '?'}</span>
        </span>
      ),
      sortValue: (trial) => labels.variants[trial.variantVersionId]?.label ?? '',
    },
    {
      key: 'case',
      header: '用例',
      render: (trial) => (
        <span className="truncate" style={{ maxWidth: 300, display: 'inline-block' }} title={labels.cases[trial.caseVersionId]?.preview}>
          {labels.cases[trial.caseVersionId]?.preview ?? trial.caseVersionId}
        </span>
      ),
    },
    { key: 'rep', header: '重复', align: 'right', render: (trial) => <span className="mono">{trial.repetitionIndex + 1}</span> },
    {
      key: 'eligible',
      header: '可比较',
      align: 'right',
      render: (trial) => (trial.comparisonEligible ? <Badge tone="ok">是</Badge> : <Badge tone="warn">否</Badge>),
      sortValue: (trial) => (trial.comparisonEligible ? 1 : 0),
    },
    {
      key: 'reasons',
      header: '不可比原因',
      render: (trial) => (
        <span className="small dim">{trial.ineligibilityReasons.filter((reason) => reason !== 'pending_execution').join(', ') || '—'}</span>
      ),
    },
    {
      key: 'score',
      header: '分数',
      align: 'right',
      render: (trial) => {
        const score = evaluationByTrial.get(trial.id)?.overallScore;
        return <span className="mono">{score == null ? '—' : Number(score).toFixed(3)}</span>;
      },
      sortValue: (trial) => evaluationByTrial.get(trial.id)?.overallScore ?? -1,
    },
    { key: 'attempts', header: '尝试', align: 'right', render: (trial) => <span className="mono">{trial.attempts.length}</span> },
  ];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="row" style={{ gap: 10 }}>
            运行监控 <RunStatusBadge status={run.status} />
            {active ? <span className={`dot ${connected ? 'ok' : 'warn'}`} title={connected ? '事件流已连接' : '事件流重连中'} /> : null}
          </h1>
          <div className="sub mono">
            {run.id} · 快照 {run.snapshotHash.slice(0, 20)}… · {formatDateTime(run.createdAt)}
          </div>
        </div>
        <span className="spacer" />
        <div className="sticky-actions">
          <CopyButton value={run.id} label="复制 Run ID" small />
          {active ? (
            <>
              <Select
                value={stopModelId}
                onChange={(event) => setStopModelId(event.target.value)}
                aria-label="选择要停止的模型组"
                style={{ width: 190 }}
              >
                <option value="">停止指定模型…</option>
                {Object.entries(bundle.data.labels.models).map(([id, model]) => (
                  <option key={id} value={id}>{model.name}</option>
                ))}
              </Select>
              <Button
                variant="ghost"
                disabled={!stopModelId}
                loading={stopModel.isPending}
                onClick={() => stopModel.mutate(stopModelId)}
              >
                停止该组
              </Button>
              <Button variant="danger" onClick={() => cancel.mutate()} loading={cancel.isPending}>
                停止后续请求
              </Button>
            </>
          ) : null}
          {counts.failed > 0 ? (
            <Button onClick={() => retry.mutate()} loading={retry.isPending}>
              重试失败 Trial
            </Button>
          ) : null}
          <Button onClick={() => navigate(projectPath(projectId, `/runs/${runId}/compare`))}>查看比较</Button>
          <Button variant="primary" onClick={() => navigate(projectPath(projectId, '/reports'))}>
            生成报告
          </Button>
        </div>
      </header>

      {run.stopReason ? <div className="notice warn">停止原因：{run.stopReason === 'user_cancel' ? '用户取消' : run.stopReason === 'budget_exhausted' ? '预算耗尽' : run.stopReason}</div> : null}

      <div className="grid cols-4">
        <Stat label="执行进度" value={`${finished}/${counts.total}`} hint={`排队 ${counts.queued} · 运行 ${counts.running} · 重试 ${counts.retrying}`} />
        <Stat label="输出有效性" value={`${counts.outputValid} 有效`} hint={`无效 ${outputInvalid} · 未知 ${counts.total - counts.outputValid - outputInvalid}`} tone={outputInvalid ? 'warn' : 'ok'} />
        <Stat label="评估" value={`${evalCompleted}/${counts.outputValid}`} hint={`可比较 ${counts.comparisonEligible} · 回退 ${counts.fallbackUsed}`} />
        <Stat
          label="成本"
          value={cost.data ? formatAmountValue(cost.data.amount, cost.data.currency, cost.data.complete) : '—'}
          hint={cost.data ? `${cost.data.requestCount} 次请求 · P50 ${cost.data.latency.p50Ms ?? '—'} ms · P95 ${cost.data.latency.p95Ms ?? '—'} ms` : ''}
          tone={cost.data && !cost.data.complete ? 'warn' : undefined}
        />
      </div>

      <Card>
        <div className="row">
          <span className="small dim">整体进度</span>
          <div style={{ flex: 1 }}>
            <div className="progress">
              <span style={{ width: `${counts.total ? (finished / counts.total) * 100 : 0}%` }} />
            </div>
          </div>
          <span className="mono small">{counts.total ? Math.round((finished / counts.total) * 100) : 0}%</span>
          <span className="small dim">耗时 {formatDuration(run.startedAt, run.finishedAt)}</span>
        </div>
      </Card>

      <Tabs
        tabs={[
          { id: 'trials', label: `Trial（${counts.total}）` },
          { id: 'events', label: `事件流（${events.length}）` },
          { id: 'snapshot', label: '快照' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'trials' ? (
        <Card flush>
          <DataTable
            columns={trialColumns}
            rows={bundle.data.trials}
            rowKey={(trial) => trial.id}
            onRowClick={setSelected}
            selectedKey={selected?.id ?? null}
            maxHeight={560}
            emptyText="尚无 Trial"
          />
        </Card>
      ) : null}

      {tab === 'events' ? (
        <Card flush>
          <div className="table-wrap" style={{ maxHeight: 520 }}>
            {events.length ? (
              events.map((event) => (
                <div className="event-row" key={event.seq}>
                  <span className="seq">#{event.seq}</span>
                  <span className="type">{event.type}</span>
                  <span className="truncate" title={JSON.stringify(event.payload)}>
                    {event.payload ? JSON.stringify(event.payload) : '—'}
                  </span>
                  <span className="small dim">{new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                </div>
              ))
            ) : (
              <div className="table-empty">尚无事件</div>
            )}
          </div>
        </Card>
      ) : null}

      {tab === 'snapshot' ? (
        <div className="grid cols-2">
          <Card title="冻结参数">
            <dl className="kv">
              <dt>快照哈希</dt>
              <dd className="mono">{snapshotSummary.hash}</dd>
              <dt>测试集</dt>
              <dd>{labels.testSetName}（{snapshotSummary.caseCount} 条）</dd>
              <dt>重复</dt>
              <dd>{snapshotSummary.repetitions}</dd>
              <dt>执行</dt>
              <dd className="mono">
                attempts={snapshotSummary.execution.maxAttempts} · concurrency={snapshotSummary.execution.maxConcurrency} · order={snapshotSummary.execution.order}
              </dd>
              <dt>预算</dt>
              <dd className="mono">{JSON.stringify(snapshotSummary.budget)}</dd>
              <dt>评估</dt>
              <dd>
                {snapshotSummary.evaluation.name}
                {snapshotSummary.evaluation.scale
                  ? ` · ${snapshotSummary.evaluation.scale.min}—${snapshotSummary.evaluation.scale.max} 刻度`
                  : ' · 0—1 小数'}
                {' · '}
                {snapshotSummary.evaluation.dimensions
                  .map((dimension) =>
                    dimension.normalizedWeight == null
                      ? `${dimension.name}(${dimension.weight})`
                      : `${dimension.name}(${(dimension.normalizedWeight * 100).toFixed(0)}%)`,
                  )
                  .join(' / ')}
              </dd>
            </dl>
          </Card>
          <Card title="分支与模型">
            <div className="stack" style={{ gap: 8 }}>
              {Object.entries(labels.variants).map(([versionId, variant]) => (
                <div className="row" key={versionId}>
                  <Badge tone="accent">{variant.label}</Badge>
                  <span className="small">{variant.promptName} · v{variant.versionNumber}</span>
                  <span className="spacer" />
                  <span className="mono small dim">{variant.contentHash.slice(0, 14)}…</span>
                </div>
              ))}
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                {Object.entries(labels.models).map(([versionId, model]) => (
                  <div className="row" key={versionId}>
                    <span>{model.name}</span>
                    <span className="small dim mono">{model.providerType} · {model.modelId}</span>
                    <span className="spacer" />
                    {model.isFallback ? <Badge tone="warn">回退</Badge> : <Badge tone="muted">主模型</Badge>}
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      <TrialDrawer
        trial={selected}
        onClose={() => setSelected(null)}
        labels={labels}
        evaluation={selected ? evaluationByTrial.get(selected.id) ?? null : null}
        output={selected && bundle.data.outputs ? bundle.data.outputs[selected.id] ?? null : null}
      />
    </div>
  );
}

function TrialDrawer({
  trial,
  onClose,
  labels,
  evaluation,
  output,
}: {
  trial: Trial | null;
  onClose: () => void;
  labels: RunBundle['labels'];
  evaluation: EvaluationRecord | null;
  output: TrialOutput | null;
}) {
  return (
    <Drawer open={Boolean(trial)} title={trial ? `Trial ${trial.id.slice(0, 10)}` : ''} onClose={onClose}>
      {trial ? (
        <div className="stack">
          <div className="row">
            <TrialStatusBadge status={trial.trialStatus} />
            <ValidityBadge validity={trial.outputValidity} />
            <EvaluationBadge status={trial.evaluationStatus} />
            {trial.comparisonEligible ? <Badge tone="ok">可比较</Badge> : <Badge tone="warn">不可比较</Badge>}
            <span className="spacer" />
            <IdText value={trial.id} chars={12} />
          </div>

          <dl className="kv">
            <dt>分支</dt>
            <dd>{labels.variants[trial.variantVersionId]?.label ?? '?'} · {labels.variants[trial.variantVersionId]?.promptName ?? ''}</dd>
            <dt>模型</dt>
            <dd>{labels.models[trial.modelConfigVersionId]?.name ?? '?'}（{labels.models[trial.modelConfigVersionId]?.modelId ?? ''}）</dd>
            <dt>用例</dt>
            <dd className="mono small">{labels.cases[trial.caseVersionId]?.preview ?? trial.caseVersionId}</dd>
            <dt>重复序号</dt>
            <dd>{trial.repetitionIndex + 1}</dd>
            <dt>不可比原因</dt>
            <dd>{trial.ineligibilityReasons.join(', ') || '—'}</dd>
          </dl>

          <Card title="输出">
            {output?.content ? (
              <pre className="code">{output.content}</pre>
            ) : output?.error ? (
              <div className="notice error">
                <span className="mono">{output.error.code}</span> {output.error.message}
              </div>
            ) : (
              <div className="dim">无输出</div>
            )}
            {output ? (
              <div className="row small dim" style={{ marginTop: 8 }}>
                <span>finish: {output.finishReason ?? '—'}</span>
                <span>模型: {output.modelId ?? '—'}</span>
                {output.fallbackUsed ? <Badge tone="warn">回退</Badge> : null}
                {output.cost ? <span>成本: {formatAmountValue(output.cost.amount, output.cost.currency, output.cost.billingState !== 'unknown')}</span> : null}
                {output.latencyMs ? <span>耗时: {output.latencyMs} ms</span> : null}
              </div>
            ) : null}
          </Card>

          {evaluation?.scores?.dimensions ? (
            <Card title="评分明细">
              <div className="stack" style={{ gap: 8 }}>
                {Object.entries(evaluation.scores.dimensions).map(([dimension, score]) => {
                  const detail = evaluation.scores?.details?.[dimension];
                  return (
                    <div key={dimension} className="stack" style={{ gap: 4 }}>
                      <div className="row">
                        <strong>{dimension}</strong>
                        <span className="spacer" />
                        <span className="mono">{score == null ? '—' : Number(score).toFixed(3)}</span>
                        {detail?.gating ? <Badge tone="warn">门槛 {detail.gate ?? 0.5}</Badge> : null}
                      </div>
                      {detail?.rules?.length ? (
                        <div className="small dim">
                          {detail.rules.map((rule, index) => (
                            <div key={index}>
                              {rule.passed ? '✓' : '✗'} {rule.rule ?? '规则'} {rule.detail ? `· ${rule.detail}` : ''}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <strong>总分</strong>
                  <span className="spacer" />
                  <span className="mono">{evaluation.overallScore == null ? '—' : Number(evaluation.overallScore).toFixed(3)}</span>
                </div>
              </div>
            </Card>
          ) : null}

          <Card title={`尝试记录（${trial.attempts.length}）`} flush>
            <div className="list" style={{ padding: 8 }}>
              {trial.attempts.map((attempt) => (
                <div key={attempt.id} className="list-item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                  <span className="mono">#{attempt.attemptNumber}</span>
                  <span className="small">{attempt.status}</span>
                  {attempt.fallbackUsed ? <Badge tone="warn">回退</Badge> : null}
                  <span className="spacer" />
                  <span className="small dim mono">{attempt.actualModelId}</span>
                  {attempt.error ? <span className="small" style={{ color: 'var(--red)' }}>{attempt.error.code}</span> : null}
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : null}
    </Drawer>
  );
}
