import { useState } from 'react';
import type { PromptSuggestionResult, PromptSuggestionStatus, PromptSuggestionSummary } from '@promptlens/contracts';
import { getClient } from '../../api/bridge';
import { qk, useApiMutation, useApiQuery } from '../../api/hooks';
import { navigate, projectPath } from '../../app/router';
import { Badge, Button, Card, EmptyState, ErrorNotice, Modal, Select, useToast, formatDateTime } from '../../components/ui';

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'generated', label: '待处理' },
  { value: 'accepted', label: '已采纳' },
  { value: 'dismissed', label: '已忽略' },
];

export function SuggestionHistoryPage({ projectId }: { projectId: string }) {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [detail, setDetail] = useState<PromptSuggestionResult | null>(null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);

  const suggestions = useApiQuery<{ suggestions: PromptSuggestionSummary[] }>(
    qk.projectPromptSuggestions(projectId, status),
    (client) => client.get(`/v1/projects/${projectId}/prompt-suggestions${status ? `?status=${status}` : ''}`),
  );
  const statusMutation = useApiMutation<PromptSuggestionResult, { suggestionId: string; status: PromptSuggestionStatus }>(
    (client, { suggestionId, status: nextStatus }) => client.patch(`/v1/projects/${projectId}/prompt-suggestions/${suggestionId}`, { status: nextStatus }),
    {
      invalidate: () => [qk.projectPromptSuggestions(projectId, status)],
      onSuccess: (result) => setDetail(result),
      onError: (error) => toast.push('更新建议状态失败', 'error', error instanceof Error ? error.message : String(error)),
    },
  );

  async function openDetail(suggestionId: string) {
    setDetailLoading(suggestionId);
    try {
      const client = await getClient();
      setDetail(await client.get<PromptSuggestionResult>(`/v1/projects/${projectId}/prompt-suggestions/${suggestionId}`));
    } catch (error) {
      toast.push('加载建议详情失败', 'error', error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoading(null);
    }
  }

  const items = suggestions.data?.suggestions ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>优化建议</h1>
          <div className="sub">基于运行证据生成的建议清单，独立保存且不会修改提示词。可在比较页生成新建议。</div>
        </div>
        <Select value={status} onChange={(event) => setStatus(event.target.value)}>
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>

      {suggestions.error ? <ErrorNotice error={suggestions.error} onRetry={() => suggestions.refetch()} /> : null}

      {!suggestions.isLoading && !items.length ? (
        <EmptyState title="还没有优化建议" description="先在结果比较页选择运行，点击「优化建议」生成。" />
      ) : null}

      <div className="grid cols-2">
        {items.map((item) => (
          <Card
            key={item.suggestionId}
            title={`${formatDateTime(item.createdAt)} · ${item.suggestionCount} 条建议`}
            subtitle={`运行 ${item.runId.slice(0, 12)}… · 版本 ${item.promptVersionId.slice(0, 10)}…`}
            actions={
              <Badge tone={item.status === 'accepted' ? 'ok' : item.status === 'dismissed' ? 'muted' : 'info'}>
                {item.status === 'accepted' ? '已采纳' : item.status === 'dismissed' ? '已忽略' : '待处理'}
              </Badge>
            }
          >
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <Button size="small" loading={detailLoading === item.suggestionId} onClick={() => openDetail(item.suggestionId)}>
                查看建议
              </Button>
              <Button size="small" variant="ghost" onClick={() => navigate(projectPath(projectId, `/runs/${item.runId}/compare`))}>
                查看运行
              </Button>
              {item.status !== 'accepted' ? (
                <Button size="small" onClick={() => statusMutation.mutate({ suggestionId: item.suggestionId, status: 'accepted' })}>
                  采纳
                </Button>
              ) : null}
              {item.status !== 'dismissed' ? (
                <Button size="small" variant="ghost" onClick={() => statusMutation.mutate({ suggestionId: item.suggestionId, status: 'dismissed' })}>
                  忽略
                </Button>
              ) : null}
            </div>
          </Card>
        ))}
      </div>

      <Modal open={Boolean(detail)} title="优化建议详情" wide onClose={() => setDetail(null)} footer={<Button onClick={() => setDetail(null)}>关闭</Button>}>
        {detail ? (
          <div className="stack">
            <div className="row small" style={{ flexWrap: 'wrap', gap: 6 }}>
              <Badge tone="info">{detail.base.label} v{detail.base.versionNumber}</Badge>
              <span className="dim">{detail.summary.trialCount} 个 Trial · {detail.generator.name}</span>
              <span className="spacer" />
              <Badge tone={detail.status === 'accepted' ? 'ok' : detail.status === 'dismissed' ? 'muted' : 'info'}>
                {detail.status === 'accepted' ? '已采纳' : detail.status === 'dismissed' ? '已忽略' : '待处理'}
              </Badge>
            </div>
            {detail.suggestions.map((item, index) => (
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
      </Modal>
    </div>
  );
}
