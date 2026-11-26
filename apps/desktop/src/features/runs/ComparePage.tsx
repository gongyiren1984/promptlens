import { useMemo, useState } from 'react';
import type { EvaluationRecord, ModelProfile, PromptIterationContext, PromptIterationResult, PromptSuggestionContext, PromptSuggestionResult, PromptSuggestionStatus, PromptSuggestionSummary, RunBundle, Trial, TrialOutput } from '@promptlens/contracts';
import { qk, useApiMutation, useApiQuery, useQueryInvalidator } from '../../api/hooks';
import {
  Badge,
  Button,
  Card,
  Drawer,
  ErrorNotice,
  EvaluationBadge,
  Field,
  IdText,
  Input,
  Modal,
  Select,
  Stat,
  Textarea,
  Toggle,
  TrialStatusBadge,
  ValidityBadge,
  formatAmountValue,
  formatDateTime,
  formatDuration,
  useToast,
} from '../../components/ui';
import { DataTable } from '../../components/table';
import { BarList } from '../../components/charts';
import { navigate, projectPath } from '../../app/router';
import { getClient } from '../../api/bridge';

interface Group {
  key: string;
  variantVersionId: string;
  modelConfigVersionId: string;
  variantLabel: string;
  modelName: string;
  trials: Trial[];
  eligible: Trial[];
  scores: number[];
  mean: number | null;
  ci95: number | null;
  dimensions: Record<string, number | null>;
  latencyMs: number | null;
  costAmount: number | null;
  costComplete: boolean;
}

export function ComparePage({ projectId, runId }: { projectId: string; runId: string }) {
  const toast = useToast();
  const invalidate = useQueryInvalidator();
  const [drawer, setDrawer] = useState<{ title: string; trials: Trial[] } | null>(null);
  const [iterOpen, setIterOpen] = useState(false);
  const [iterResult, setIterResult] = useState<PromptIterationResult | null>(null);
  const [iterModel, setIterModel] = useState('');
  const [iterBase, setIterBase] = useState('');
  const [iterInstruction, setIterInstruction] = useState('');
  const [iterLabel, setIterLabel] = useState('');
  const [iterSaving, setIterSaving] = useState(false);
  const [iterRounds, setIterRounds] = useState('1');
  const [iterAutoSave, setIterAutoSave] = useState(false);
  const [iterVerify, setIterVerify] = useState(false);
  const [iterContext, setIterContext] = useState<PromptIterationContext | null>(null);
  const [iterContextLoading, setIterContextLoading] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestResult, setSuggestResult] = useState<PromptSuggestionResult | null>(null);
  const [suggestModel, setSuggestModel] = useState('');
  const [suggestFocus, setSuggestFocus] = useState('');
  const [suggestMax, setSuggestMax] = useState('3');
  const [suggestContext, setSuggestContext] = useState<PromptSuggestionContext | null>(null);
  const [suggestContextLoading, setSuggestContextLoading] = useState(false);
  const [suggestDetailLoading, setSuggestDetailLoading] = useState<string | null>(null);
  const models = useApiQuery<{ models: ModelProfile[] }>(qk.models(projectId), (client) => client.get(`/v1/projects/${projectId}/models`), {
    enabled: iterOpen || suggestOpen,
  });
  const suggestions = useApiQuery<{ suggestions: PromptSuggestionSummary[] }>(
    qk.promptSuggestions(projectId, runId),
    (client) => client.get(`/v1/projects/${projectId}/runs/${runId}/prompt-suggestions`),
    { enabled: suggestOpen },
  );
  const suggestion = useApiMutation<
    PromptSuggestionResult,
    { modelConfigVersionId: string; focus: string; maxSuggestions: number }
  >(
    (client, body) => client.post(`/v1/projects/${projectId}/runs/${runId}/prompt-suggestions`, body),
    {
      onSuccess: (result) => {
        setSuggestResult(result);
        invalidate(qk.promptSuggestions(projectId, runId));
      },
      onError: (error) => toast.push('生成优化建议失败', 'error', error instanceof Error ? error.message : String(error)),
    },
  );
  const suggestionStatus = useApiMutation<
    PromptSuggestionResult,
    { suggestionId: string; status: PromptSuggestionStatus }
  >(
    (client, { suggestionId, status }) => client.patch(`/v1/projects/${projectId}/prompt-suggestions/${suggestionId}`, { status }),
    {
      onSuccess: (result) => {
        setSuggestResult(result);
        invalidate(qk.promptSuggestions(projectId, runId));
      },
      onError: (error) => toast.push('更新建议状态失败', 'error', error instanceof Error ? error.message : String(error)),
    },
  );
  async function loadSuggestion(suggestionId: string) {
    setSuggestDetailLoading(suggestionId);
    try {
      const client = await getClient();
      const detail = await client.get<PromptSuggestionResult>(`/v1/projects/${projectId}/prompt-suggestions/${suggestionId}`);
      setSuggestResult(detail);
    } catch (error) {
      toast.push('加载优化建议失败', 'error', error instanceof Error ? error.message : String(error));
    } finally {
      setSuggestDetailLoading(null);
    }
  }

  const suggestionModelId = suggestModel || models.data?.models.find((model) => model.latest)?.latest?.modelConfigVersionId || '';

  async function previewSuggestions() {
    if (!suggestionModelId) return;
    setSuggestContextLoading(true);
    try {
      const client = await getClient();
      const query = new URLSearchParams({ modelConfigVersionId: suggestionModelId, maxSuggestions: suggestMax });
      const context = await client.get<PromptSuggestionContext>(`/v1/projects/${projectId}/runs/${runId}/prompt-suggestions/context?${query.toString()}`);
      setSuggestContext(context);
    } catch (error) {
      toast.push('加载建议预览失败', 'error', error instanceof Error ? error.message : String(error));
    } finally {
      setSuggestContextLoading(false);
    }
  }

  const iteration = useApiMutation<
    PromptIterationResult,
    { modelConfigVersionId: string; promptVersionId?: string; instruction: string; rounds: number; save?: boolean; verify?: boolean }
  >(
    (client, body) => client.post(`/v1/projects/${projectId}/runs/${runId}/prompt-iteration`, body),
    {
      onSuccess: (result) => {
        setIterResult(result);
        setIterLabel(result.proposal.label);
      },
      onError: (error) => toast.push('生成改进稿失败', 'error', error instanceof Error ? error.message : String(error)),
    },
  );

  async function previewIteration() {
    const modelId = iterModel || models.data?.models.find((model) => model.latest)?.latest?.modelConfigVersionId;
    if (!modelId) return;
    setIterContextLoading(true);
    try {
      const client = await getClient();
      const query = new URLSearchParams({ modelConfigVersionId: modelId, rounds: iterRounds });
      if (iterBase) query.set('promptVersionId', iterBase);
      const context = await client.get<PromptIterationContext>(`/v1/projects/${projectId}/runs/${runId}/prompt-iteration/context?${query.toString()}`);
      setIterContext(context);
    } catch (error) {
      toast.push('加载迭代预览失败', 'error', error instanceof Error ? error.message : String(error));
    } finally {
      setIterContextLoading(false);
    }
  }

  async function saveProposal() {
    if (!iterResult || !iterLabel.trim()) return;
    setIterSaving(true);
    try {
      const client = await getClient();
      const saved = await client.post<{ versionId: string; label: string; versionNumber: number; created: boolean }>(
        `/v1/projects/${projectId}/prompts/${iterResult.base.promptId}/variants`,
        { label: iterLabel.trim(), content: iterResult.proposal.content },
      );
      setIterResult({
        ...iterResult,
        proposal: { ...iterResult.proposal, label: saved.label, versionId: saved.versionId, versionNumber: saved.versionNumber, created: saved.created },
        rounds: iterResult.rounds?.map((round, index) => (index === 0 ? { ...round, label: saved.label, saved } : round)),
      });
      invalidate(qk.prompts(projectId));
      toast.push('已保存新的提示词分支', 'success', `${saved.label} v${saved.versionNumber}`);
    } catch (error) {
      toast.push('保存失败', 'error', error instanceof Error ? error.message : String(error));
    } finally {
      setIterSaving(false);
    }
  }
  const bundle = useApiQuery<RunBundle>(
    qk.run(projectId, runId),
    (client) => client.get(`/v1/projects/${projectId}/runs/${runId}`, { query: { includeOutputs: 1, trialLimit: 2000 } }),
    { staleTime: 10_000 },
  );

  const evaluationByTrial = useMemo(() => {
    const map = new Map<string, EvaluationRecord>();
    for (const item of bundle.data?.evaluations ?? []) map.set(item.trialId, item);
    return map;
  }, [bundle.data]);

  const groups = useMemo<Group[]>(() => {
    if (!bundle.data) return [];
    const map = new Map<string, Group>();
    for (const trial of bundle.data.trials) {
      const key = `${trial.variantVersionId}::${trial.modelConfigVersionId}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          variantVersionId: trial.variantVersionId,
          modelConfigVersionId: trial.modelConfigVersionId,
          variantLabel: bundle.data.labels.variants[trial.variantVersionId]?.label ?? '?',
          modelName: bundle.data.labels.models[trial.modelConfigVersionId]?.name ?? '?',
          trials: [],
          eligible: [],
          scores: [],
          mean: null,
          ci95: null,
          dimensions: {},
          latencyMs: null,
          costAmount: null,
          costComplete: true,
        });
      }
      const group = map.get(key)!;
      group.trials.push(trial);
      if (trial.comparisonEligible) {
        group.eligible.push(trial);
        const score = evaluationByTrial.get(trial.id)?.overallScore;
        if (score != null) group.scores.push(Number(score));
      }
      const output = bundle.data.outputs?.[trial.id];
      if (output?.latencyMs) group.latencyMs = (group.latencyMs ?? 0) + output.latencyMs;
      if (output?.cost) {
        if (output.cost.amount == null) group.costComplete = false;
        else group.costAmount = (group.costAmount ?? 0) + Number(output.cost.amount);
      }
    }
    for (const group of map.values()) {
      if (group.scores.length) {
        const mean = group.scores.reduce((sum, value) => sum + value, 0) / group.scores.length;
        group.mean = mean;
        if (group.scores.length > 1) {
          const sd = Math.sqrt(group.scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (group.scores.length - 1));
          group.ci95 = 1.96 * (sd / Math.sqrt(group.scores.length));
        }
        const dimensionIds = bundle.data.snapshotSummary.evaluation.dimensions.map((dimension) => dimension.id);
        for (const dimensionId of dimensionIds) {
          const values = group.eligible
            .map((trial) => evaluationByTrial.get(trial.id)?.scores?.dimensions?.[dimensionId])
            .filter((value): value is number => typeof value === 'number');
          group.dimensions[dimensionId] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        }
      }
      if (group.latencyMs && group.eligible.length) group.latencyMs = Math.round(group.latencyMs / group.eligible.length);
    }
    return [...map.values()];
  }, [bundle.data, evaluationByTrial]);

  const cases = useMemo(() => {
    if (!bundle.data) return [];
    const seen = new Map<string, { preview: string; order: number }>();
    let order = 0;
    for (const trial of bundle.data.trials) {
      if (!seen.has(trial.caseVersionId)) {
        seen.set(trial.caseVersionId, { preview: bundle.data.labels.cases[trial.caseVersionId]?.preview ?? trial.caseVersionId, order: order++ });
      }
    }
    return [...seen.entries()].map(([caseVersionId, meta]) => ({ caseVersionId, ...meta })).sort((a, b) => a.order - b.order);
  }, [bundle.data]);

  const failures = useMemo(() => {
    if (!bundle.data) return [];
    return bundle.data.trials.filter(
      (trial) => trial.trialStatus === 'failed' || trial.trialStatus === 'canceled' || (trial.outputValidity !== 'valid' && trial.outputValidity !== 'not_available'),
    );
  }, [bundle.data]);

  const failureReasons = useMemo(() => {
    const counts = new Map<string, number>();
    for (const trial of bundle.data?.trials ?? []) {
      for (const reason of trial.ineligibilityReasons) {
        if (reason === 'pending_execution') continue;
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [bundle.data]);

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
          <span className="spinner" /> 加载比较数据…
        </div>
      </div>
    );
  }

  const { run, labels, counts, snapshotSummary } = bundle.data;
  const dimensionMeta = snapshotSummary.evaluation.dimensions;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>结果比较</h1>
          <div className="sub mono">
            {run.id} · {labels.testSetName} · {snapshotSummary.caseCount} 条用例 · {snapshotSummary.repetitions} 次重复
          </div>
        </div>
        <span className="spacer" />
        <div className="sticky-actions">
          <Button onClick={() => navigate(projectPath(projectId, `/runs/${runId}`))}>返回监控</Button>
          <Button
            onClick={() => {
              setSuggestOpen(true);
              setSuggestResult(null);
              setSuggestFocus('');
              setSuggestContext(null);
            }}
          >
            优化建议
          </Button>
          <Button
            onClick={() => {
              setIterOpen(true);
              setIterResult(null);
              setIterInstruction('');
              setIterBase('');
            }}
          >
            迭代提示词
          </Button>
          <Button variant="primary" onClick={() => navigate(projectPath(projectId, '/reports'))}>
            查看报告
          </Button>
        </div>
      </header>

      <div className="grid cols-4">
        <Stat label="可比较 Trial" value={counts.comparisonEligible} hint={`共 ${counts.total} · 无效 ${counts.outputInvalid}`} />
        <Stat label="分支 × 模型" value={groups.length} hint={`${snapshotSummary.variants.length} 分支 · ${snapshotSummary.models.length} 模型`} />
        <Stat label="回退 Trial" value={counts.fallbackUsed} hint="已排除出对照均值" tone={counts.fallbackUsed ? 'warn' : undefined} />
        <Stat label="失败/取消" value={counts.failed + counts.canceled} hint={`失败 ${counts.failed} · 取消 ${counts.canceled}`} tone={counts.failed ? 'error' : undefined} />
      </div>

      <Card title="分组均值" subtitle="均值只统计可比较且已评估的 Trial；误差条为 95% 正态近似">
        <BarList
          items={groups.map((group) => ({
            label: `${group.variantLabel} / ${group.modelName}（n=${group.scores.length}）`,
            value: group.mean ?? 0,
            display: group.mean == null ? '—' : group.mean.toFixed(3),
            tone: group.scores.length ? 'default' : 'alt',
          }))}
          max={1}
        />
        <div style={{ marginTop: 14 }}>
          <DataTable
            columns={[
              { key: 'group', header: '分支 / 模型', render: (group: Group) => <span>{group.variantLabel} / {group.modelName}</span> },
              { key: 'n', header: '有效样本', align: 'right', render: (group: Group) => group.eligible.length },
              { key: 'mean', header: '均值', align: 'right', render: (group: Group) => <span className="mono">{group.mean == null ? '—' : group.mean.toFixed(3)}</span> },
              { key: 'ci', header: '95% CI', align: 'right', render: (group: Group) => <span className="mono">{group.ci95 == null ? '—' : `±${group.ci95.toFixed(3)}`}</span> },
              ...dimensionMeta.map((dimension) => ({
                key: dimension.id,
                header: dimension.name,
                align: 'right' as const,
                render: (group: Group) => <span className="mono">{group.dimensions[dimension.id] == null ? '—' : Number(group.dimensions[dimension.id]).toFixed(3)}</span>,
              })),
              { key: 'latency', header: '平均耗时', align: 'right', render: (group: Group) => <span className="mono">{group.latencyMs == null ? '—' : `${group.latencyMs} ms`}</span> },
              {
                key: 'cost',
                header: '成本',
                align: 'right',
                render: (group: Group) => (
                  <span className="mono">{group.costComplete ? (group.costAmount == null ? '—' : formatAmountValue(group.costAmount.toFixed(6), null)) : '未知'}</span>
                ),
              },
            ]}
            rows={groups}
            rowKey={(group) => group.key}
            maxHeight={340}
          />
        </div>
      </Card>

      <Card
        title="配对矩阵"
        subtitle="行=用例，列=分支×模型；单元格为该组合跨重复的均值，点击查看证据"
        flush
      >
        <div className="table-wrap" style={{ maxHeight: 520 }}>
          <table className="matrix">
            <thead>
              <tr>
                <th style={{ minWidth: 240 }}>用例</th>
                {groups.map((group) => (
                  <th key={group.key}>
                    {group.variantLabel} / {group.modelName}
                    <div className="small" style={{ textTransform: 'none', color: 'var(--muted)' }}>
                      n={group.eligible.length}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cases.map((item) => (
                <tr key={item.caseVersionId}>
                  <td className="truncate" style={{ maxWidth: 340 }} title={item.preview}>
                    {item.preview}
                  </td>
                  {groups.map((group) => {
                    const cell = group.trials.filter((trial) => trial.caseVersionId === item.caseVersionId);
                    const scores = cell
                      .filter((trial) => trial.comparisonEligible)
                      .map((trial) => evaluationByTrial.get(trial.id)?.overallScore)
                      .filter((value): value is number => value != null);
                    const mean = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
                    return (
                      <td
                        key={group.key}
                        className="cell"
                        onClick={() => setDrawer({ title: `${group.variantLabel} / ${group.modelName} · ${item.preview}`, trials: cell })}
                      >
                        {mean == null ? (
                          <span className="small dim">不可比</span>
                        ) : (
                          <span className="cell-score" style={{ color: mean >= 0.8 ? 'var(--green)' : mean >= 0.5 ? 'var(--accent)' : 'var(--red)' }}>
                            {mean.toFixed(3)}
                          </span>
                        )}
                        <div className="small dim">
                          {cell.filter((trial) => trial.outputValidity === 'valid').length}/{cell.length} 有效
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid cols-2">
        <Card title="失败与无效输出" subtitle={`${failures.length} 个 Trial`} flush>
          {failures.length ? (
            <DataTable
              columns={[
                { key: 'trial', header: 'Trial', render: (trial: Trial) => <IdText value={trial.id} chars={10} /> },
                { key: 'status', header: '执行', render: (trial: Trial) => <TrialStatusBadge status={trial.trialStatus} /> },
                { key: 'validity', header: '输出', render: (trial: Trial) => <ValidityBadge validity={trial.outputValidity} /> },
                { key: 'reasons', header: '原因', render: (trial: Trial) => <span className="small dim">{trial.ineligibilityReasons.join(', ') || '—'}</span> },
              ]}
              rows={failures}
              rowKey={(trial) => trial.id}
              onRowClick={(trial) => setDrawer({ title: `Trial ${trial.id.slice(0, 10)}`, trials: [trial] })}
              maxHeight={300}
            />
          ) : (
            <div className="table-empty">没有失败或无效输出</div>
          )}
        </Card>

        <Card title="不可比原因分布">
          <BarList
            items={failureReasons.map(([reason, count]) => ({ label: reason, value: count, display: String(count), tone: 'alt' }))}
            emptyText="没有不可比 Trial"
          />
        </Card>
      </div>

      <EvidenceDrawer
        state={drawer}
        onClose={() => setDrawer(null)}
        labels={labels}
        outputs={bundle.data.outputs ?? {}}
        evaluationByTrial={evaluationByTrial}
      />

      <Modal
        open={suggestOpen}
        title="提示词优化建议"
        wide
        onClose={() => setSuggestOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSuggestOpen(false)}>关闭</Button>
            <Button
              variant="primary"
              loading={suggestion.isPending}
              disabled={!suggestionModelId}
              onClick={() =>
                suggestion.mutate({
                  modelConfigVersionId: suggestionModelId,
                  focus: suggestFocus.trim(),
                  maxSuggestions: Number(suggestMax),
                })
              }
            >
              生成建议
            </Button>
          </>
        }
      >
        <div className="stack">
          <div className="notice">建议作为独立内容保存，不会修改任何提示词版本；如需生成改进稿，请使用「迭代提示词」。</div>
          <div className="grid cols-3">
            <Field label="诊断模型">
              <Select value={suggestionModelId} onChange={(event) => setSuggestModel(event.target.value)}>
                {models.data?.models.filter((model) => model.latest).map((model) => (
                  <option key={model.profileId} value={model.latest!.modelConfigVersionId}>
                    {model.name} v{model.latest!.versionNumber}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="建议条数">
              <Select value={suggestMax} onChange={(event) => setSuggestMax(event.target.value)}>
                <option value="1">1 条</option>
                <option value="3">3 条</option>
                <option value="5">5 条</option>
                <option value="10">10 条</option>
              </Select>
            </Field>
            <Field label="关注点（可选）">
              <Input value={suggestFocus} onChange={(event) => setSuggestFocus(event.target.value)} placeholder="例如：减少编造、统一 JSON 结构" />
            </Field>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <Button size="small" loading={suggestContextLoading} onClick={previewSuggestions}>
              预览证据与成本
            </Button>
            {suggestContext ? (
              <span className="small dim">
                证据 {suggestContext.evidenceCount} 个 Trial · 低分维度 {suggestContext.lowDimensions.length} 个 ·{' '}
                {suggestContext.cost.amount === null ? `成本未知（${suggestContext.cost.completeness}）` : `${suggestContext.cost.amount} ${suggestContext.cost.currency ?? ''}`}
              </span>
            ) : null}
          </div>
          {suggestion.error ? <ErrorNotice error={suggestion.error as Error} /> : null}

          {suggestResult ? (
            <div className="stack">
              <div className="row small" style={{ flexWrap: 'wrap', gap: 6 }}>
                <Badge tone="info">{suggestResult.base.label} v{suggestResult.base.versionNumber}</Badge>
                <span className="dim">
                  {suggestResult.summary.trialCount} 个 Trial · 生成于 {formatDateTime(suggestResult.createdAt)}
                </span>
                <span className="spacer" />
                <Badge tone={suggestResult.status === 'accepted' ? 'ok' : suggestResult.status === 'dismissed' ? 'muted' : 'info'}>
                  {suggestResult.status === 'accepted' ? '已采纳' : suggestResult.status === 'dismissed' ? '已忽略' : '待处理'}
                </Badge>
                {suggestResult.status !== 'accepted' ? (
                  <Button
                    size="small"
                    loading={suggestionStatus.isPending}
                    onClick={() => suggestionStatus.mutate({ suggestionId: suggestResult.suggestionId, status: 'accepted' })}
                  >
                    采纳
                  </Button>
                ) : null}
                {suggestResult.status !== 'dismissed' ? (
                  <Button
                    size="small"
                    variant="ghost"
                    loading={suggestionStatus.isPending}
                    onClick={() => suggestionStatus.mutate({ suggestionId: suggestResult.suggestionId, status: 'dismissed' })}
                  >
                    忽略
                  </Button>
                ) : null}
              </div>
              {suggestResult.suggestions.map((item, index) => (
                <Card
                  key={index}
                  title={`${index + 1}. ${item.issue}`}
                  actions={
                    <div className="row" style={{ gap: 6 }}>
                      <Badge tone={item.priority === 'high' ? 'error' : item.priority === 'medium' ? 'warn' : 'muted'}>
                        {item.priority === 'high' ? '高优先级' : item.priority === 'medium' ? '中优先级' : '低优先级'}
                      </Badge>
                      {item.dimensionName ? <Badge tone="info">{item.dimensionName}</Badge> : null}
                    </div>
                  }
                >
                  <div className="stack" style={{ gap: 6 }}>
                    <div className="notice">{item.suggestion}</div>
                    {item.expectedImpact ? <div className="small dim">预期影响：{item.expectedImpact}</div> : null}
                    {item.evidence.length ? (
                      <details>
                        <summary className="small dim">证据（{item.evidence.length} 条）</summary>
                        <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                          {item.evidence.map((evidence, evidenceIndex) => (
                            <div key={evidenceIndex} className="small">
                              <span className="mono">得分 {evidence.score ?? '—'}</span>
                              <div className="dim">输入：{evidence.casePreview}</div>
                              <div className="dim">输出：{evidence.outputPreview}</div>
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </div>
                </Card>
              ))}
            </div>
          ) : null}

          <div className="section-title">
            <span>历史建议</span>
            <span className="spacer" />
            <span className="small dim">{(suggestions.data?.suggestions ?? []).length} 条</span>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            {(suggestions.data?.suggestions ?? []).map((item) => (
              <Button
                key={item.suggestionId}
                size="small"
                variant={suggestResult?.suggestionId === item.suggestionId ? 'primary' : 'ghost'}
                loading={suggestDetailLoading === item.suggestionId}
                onClick={() => loadSuggestion(item.suggestionId)}
              >
                {formatDateTime(item.createdAt)} · {item.suggestionCount} 条建议
              </Button>
            ))}
            {!suggestions.data?.suggestions.length ? <div className="small dim">尚无历史建议。</div> : null}
          </div>
        </div>
      </Modal>

      <Modal
        open={iterOpen}
        title="基于结果迭代提示词"
        onClose={() => setIterOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setIterOpen(false)}>关闭</Button>
            <Button
              variant="primary"
              disabled={!iterResult || Boolean(iterResult.proposal.versionId) || !iterLabel.trim()}
              loading={iterSaving}
              onClick={saveProposal}
            >
              {iterResult?.proposal.versionId ? '已保存新版本' : '保存为新分支'}
            </Button>
          </>
        }
      >
        <div className="stack">
          <div className="row">
            <Field label="改进模型">
              <Select
                value={iterModel || models.data?.models.find((model) => model.latest)?.latest?.modelConfigVersionId || ''}
                onChange={(event) => setIterModel(event.target.value)}
              >
                {(models.data?.models ?? []).filter((model) => model.latest).map((model) => (
                  <option key={model.profileId} value={model.latest!.modelConfigVersionId}>
                    {model.name}（{model.providerType}）
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="基准版本" hint="留空则自动选择均分最低的分支">
              <Select value={iterBase} onChange={(event) => setIterBase(event.target.value)}>
                <option value="">自动选择</option>
                {Object.entries(labels.variants).map(([versionId, variant]) => (
                  <option key={versionId} value={versionId}>{variant.label}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="改进要求" hint="例如：减少猜测，信息不足时明确说明；统一回答长度。">
            <Textarea rows={2} value={iterInstruction} onChange={(event) => setIterInstruction(event.target.value)} />
          </Field>
          <div className="grid cols-3">
            <Field label="轮数" hint="每轮在前一轮候选上继续改进">
              <Select value={iterRounds} onChange={(event) => setIterRounds(event.target.value)}>
                <option value="1">1 轮</option>
                <option value="2">2 轮</option>
                <option value="3">3 轮</option>
              </Select>
            </Field>
            <Toggle checked={iterAutoSave} onChange={setIterAutoSave} label="生成后保存" hint="每一轮候选各自保存为新版本" />
            <Toggle checked={iterVerify} onChange={setIterVerify} label="保存后验证" hint="每轮创建独立验证 Run 与报告版本" />
          </div>
          <div className="row">
            <Button size="small" loading={iterContextLoading} onClick={previewIteration}>
              预览证据与成本
            </Button>
            {iterContext ? (
              <span className="small dim">
                低分证据 {iterContext.evidence.lowScores.length} 条 · {iterContext.rounds.requested}/{iterContext.rounds.max} 轮 ·{' '}
                {iterContext.cost.amount === null ? `成本未知（${iterContext.cost.completeness}）` : `${iterContext.cost.amount} ${iterContext.cost.currency ?? ''}`}
              </span>
            ) : null}
          </div>
          <div className="row">
            <Button
              loading={iteration.isPending}
              disabled={!models.data?.models.some((model) => model.latest)}
              onClick={() => {
                const modelId = iterModel || models.data?.models.find((model) => model.latest)?.latest?.modelConfigVersionId;
                if (!modelId) return;
                setIterResult(null);
                iteration.mutate({
                  modelConfigVersionId: modelId,
                  promptVersionId: iterBase || undefined,
                  instruction: iterInstruction.trim(),
                  rounds: Number(iterRounds),
                  save: iterAutoSave,
                  verify: iterAutoSave && iterVerify,
                });
              }}
            >
              生成改进稿
            </Button>
            {iterResult ? <span className="small dim">{iterResult.generator.name} · {iterResult.generator.latencyMs} ms · {iterResult.cost.amount === null ? '未计费' : `${iterResult.cost.amount} ${iterResult.cost.currency ?? ''}`}</span> : null}
          </div>

          {iterResult ? (
            <>
              <div className="row small">
                <Badge tone="accent">{iterResult.base.label} v{iterResult.base.versionNumber}</Badge>
                <span className="dim">均值最低分支：{iterResult.evidence.variants[0]?.label}（{iterResult.evidence.variants[0]?.meanScore ?? '—'}）</span>
                {iterResult.diff.identical ? <Badge tone="ok">内容一致</Badge> : <Badge tone="warn">有改动</Badge>}
              </div>
              {iterResult.rounds?.length ? (
                iterResult.rounds.map((round) => (
                  <div key={round.round} className="stack" style={{ gap: 6 }}>
                    <div className="row small" style={{ flexWrap: 'wrap', gap: 6 }}>
                      <Badge tone="accent">第 {round.round} 轮 · {round.label}</Badge>
                      {round.saved ? <Badge tone="ok">已保存 v{round.saved.versionNumber}</Badge> : <Badge tone="muted">未保存</Badge>}
                      <Badge tone={round.verification.runId ? 'warn' : 'muted'}>
                        {round.verification.runId ? '候选（验证中）' : '候选（未验证）'}
                      </Badge>
                      {round.diff.identical ? <span className="dim">内容一致</span> : null}
                      {round.verification.runId ? (
                        <Button size="small" variant="ghost" onClick={() => navigate(projectPath(projectId, `/runs/${round.verification.runId}`))}>
                          查看验证 Run
                        </Button>
                      ) : null}
                    </div>
                    {round.rationale ? <div className="notice">{round.rationale}</div> : null}
                    <div className="diff" style={{ maxHeight: 220, overflow: 'auto' }}>
                      {round.diff.lines.map((line, index) => (
                        <div key={index} className={`diff-line ${line.type}`}>
                          <span className="ln">{line.leftLine ?? ''}</span>
                          <span className="ln">{line.rightLine ?? ''}</span>
                          <span>{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</span>
                          <span>{line.line || ' '}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <>
                  {iterResult.proposal.rationale ? <div className="notice">{iterResult.proposal.rationale}</div> : null}
                  <div className="diff" style={{ maxHeight: 280, overflow: 'auto' }}>
                    {iterResult.diff.lines.map((line, index) => (
                      <div key={index} className={`diff-line ${line.type}`}>
                        <span className="ln">{line.leftLine ?? ''}</span>
                        <span className="ln">{line.rightLine ?? ''}</span>
                        <span>{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</span>
                        <span>{line.line || ' '}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <Field label="新分支标签" hint="未自动保存时，可手动保存首轮候选；保存后可在新建实验中选择该分支与基准版本做 A/B">
                <Input value={iterLabel} onChange={(event) => setIterLabel(event.target.value)} className="mono" />
              </Field>
              {iterResult.proposal.versionId ? (
                <div className="notice ok">已保存为 {iterResult.proposal.label} v{iterResult.proposal.versionNumber}，可在提示词实验室查看 Diff。</div>
              ) : null}
            </>
          ) : (
            <div className="small dim">生成会读取本次运行的可比评分与低分用例；改进稿不会自动写入，需点击“保存为新分支”。</div>
          )}
        </div>
      </Modal>
    </div>
  );
}

function EvidenceDrawer({
  state,
  onClose,
  labels,
  outputs,
  evaluationByTrial,
}: {
  state: { title: string; trials: Trial[] } | null;
  onClose: () => void;
  labels: RunBundle['labels'];
  outputs: Record<string, TrialOutput>;
  evaluationByTrial: Map<string, EvaluationRecord>;
}) {
  return (
    <Drawer open={Boolean(state)} title={state?.title ?? '证据'} onClose={onClose}>
      {state ? (
        <div className="stack">
          {state.trials.map((trial) => {
            const output = outputs[trial.id];
            const evaluation = evaluationByTrial.get(trial.id);
            return (
              <Card key={trial.id} title={`Trial ${trial.id.slice(0, 10)}`} subtitle={formatDateTime(new Date().toISOString())}>
                <div className="stack">
                  <div className="row">
                    <TrialStatusBadge status={trial.trialStatus} />
                    <ValidityBadge validity={trial.outputValidity} />
                    <EvaluationBadge status={trial.evaluationStatus} />
                    {trial.comparisonEligible ? <Badge tone="ok">可比较</Badge> : <Badge tone="warn">不可比较</Badge>}
                    <span className="spacer" />
                    <span className="small dim">{labels.models[trial.modelConfigVersionId]?.name}</span>
                  </div>
                  <dl className="kv">
                    <dt>用例</dt>
                    <dd className="small">{labels.cases[trial.caseVersionId]?.preview}</dd>
                    <dt>重复</dt>
                    <dd>第 {trial.repetitionIndex + 1} 次</dd>
                    <dt>原因</dt>
                    <dd className="small">{trial.ineligibilityReasons.join(', ') || '—'}</dd>
                  </dl>
                  {trial.dialogueTurns?.length ? (
                    <div className="stack" style={{ gap: 8 }}>
                      <div className="row small dim">
                        <span>对话转录</span>
                        <span className="spacer" />
                        <span>
                          终止：{output?.dialogue?.terminationReason ?? '—'} · {trial.dialogueTurns.length} 轮消息
                        </span>
                      </div>
                      {trial.dialogueTurns.map((turn) => (
                        <div
                          key={turn.id}
                          style={{
                            borderLeft: `3px solid ${turn.role === 'candidate' ? 'var(--accent)' : 'var(--border)'}`,
                            paddingLeft: 8,
                          }}
                        >
                          <div className="row small">
                            <Badge tone={turn.role === 'candidate' ? 'info' : 'warn'}>
                              {turn.role === 'candidate' ? 'A 被测' : 'B 生成'}
                            </Badge>
                            <span className="dim">{labels.models[turn.modelConfigVersionId]?.name ?? turn.modelId}</span>
                            <span className="spacer" />
                            <span className="dim">
                              第 {turn.round} 轮 · {formatDateTime(turn.createdAt)}
                            </span>
                          </div>
                          <pre className="code">{turn.content}</pre>
                          <div className="row small dim">
                            {turn.usage ? (
                              <span>
                                in {turn.usage.inputTokens ?? '—'} / out {turn.usage.outputTokens ?? '—'}
                              </span>
                            ) : null}
                            {turn.terminationReason ? <Badge tone="warn">{turn.terminationReason}</Badge> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {output?.content ? <pre className="code">{output.content}</pre> : <div className="dim small">无输出内容</div>}
                  <div className="row small dim">
                    <span>finish: {output?.finishReason ?? '—'}</span>
                    {output?.fallbackUsed ? <Badge tone="warn">回退</Badge> : null}
                    {output?.cost ? <span>成本 {formatAmountValue(output.cost.amount, output.cost.currency, output.cost.billingState !== 'unknown')}</span> : null}
                    {output?.latencyMs ? <span>{output.latencyMs} ms</span> : null}
                  </div>
                  {evaluation?.scores?.dimensions ? (
                    <div className="small">
                      {Object.entries(evaluation.scores.dimensions).map(([dimension, score]) => (
                        <div key={dimension} className="row">
                          <span className="dim">{dimension}</span>
                          <span className="spacer" />
                          <span className="mono">{score == null ? '—' : Number(score).toFixed(3)}</span>
                        </div>
                      ))}
                      <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                        <strong>总分</strong>
                        <span className="spacer" />
                        <span className="mono">{evaluation.overallScore == null ? '—' : Number(evaluation.overallScore).toFixed(3)}</span>
                      </div>
                    </div>
                  ) : null}
                  <div className="small dim">
                    尝试 {trial.attempts.length} 次 · 耗时 {formatDuration(trial.attempts[0]?.startedAt, trial.attempts[trial.attempts.length - 1]?.finishedAt)}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      ) : null}
    </Drawer>
  );
}
