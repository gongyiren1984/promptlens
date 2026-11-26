import { useEffect, useMemo, useState } from 'react';
import type { Prompt, PromptDiff, PromptVersionDetail, PromptVersionSummary } from '@promptlens/contracts';
import { getClient } from '../../api/bridge';
import { qk, useApiMutation, useApiQuery, useQueryInvalidator } from '../../api/hooks';
import { Badge, Button, Card, CopyButton, EmptyState, ErrorNotice, Field, Input, Modal, Textarea, formatDateTime, useToast } from '../../components/ui';
import { PromptDiffView } from './PromptDiffView';

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function PromptsPage({ projectId }: { projectId: string }) {
  const { push } = useToast();
  const invalidate = useQueryInvalidator();
  const prompts = useApiQuery<{ prompts: Prompt[] }>(qk.prompts(projectId), (client) => client.get(`/v1/projects/${projectId}/prompts`));
  const [selected, setSelected] = useState<{ promptId: string; variantId: string } | null>(null);
  const [version, setVersion] = useState<PromptVersionDetail | null>(null);
  const [draft, setDraft] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [diff, setDiff] = useState<PromptDiff | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', label: 'A', content: '' });
  const [branchForm, setBranchForm] = useState({ label: '', content: '' });
  const [loadingVersion, setLoadingVersion] = useState(false);

  const currentPrompt = prompts.data?.prompts.find((item) => item.promptId === selected?.promptId) ?? null;
  const currentVariant = currentPrompt?.variants.find((item) => item.variantId === selected?.variantId) ?? null;

  async function loadVersion(versionId: string) {
    setLoadingVersion(true);
    try {
      const client = await getClient();
      const detail = await client.get<PromptVersionDetail>(`/v1/projects/${projectId}/prompt-versions/${versionId}`);
      setVersion(detail);
      setDraft(detail.content);
      setSelected({ promptId: detail.promptId, variantId: detail.variantId });
    } catch (error) {
      push((error as Error).message, 'error');
    } finally {
      setLoadingVersion(false);
    }
  }

  useEffect(() => {
    if (prompts.data?.prompts.length && !selected) {
      const firstPrompt = prompts.data.prompts[0];
      const firstVariant = firstPrompt.variants[0];
      if (firstVariant?.latestVersionId) void loadVersion(firstVariant.latestVersionId);
    }
  }, [prompts.data]);

  const saveVersion = useApiMutation(
    (client, value: { promptId: string; variantId: string; label: string; content: string }) =>
      client.post(`/v1/projects/${projectId}/prompts/${value.promptId}/variants`, { label: value.label, content: value.content }),
    {
      invalidate: () => [qk.prompts(projectId), qk.promptVersion(projectId, '*')],
      onSuccess: async (result) => {
        const data = result as { versionId: string; created: boolean };
        push(data.created ? '已保存新版本' : '内容未变化，复用现有版本', data.created ? 'success' : 'info');
        await invalidate(qk.prompts(projectId));
        await loadVersion(data.versionId);
      },
      onError: (error) => push((error as Error).message, 'error'),
    },
  );

  const restoreVersion = useApiMutation(
    (client, versionId: string) => client.post(`/v1/projects/${projectId}/prompt-versions/${versionId}/restore`),
    {
      invalidate: () => [qk.prompts(projectId), qk.promptVersion(projectId, '*')],
      onSuccess: async (result) => {
        const data = result as { versionId: string; created: boolean };
        push(data.created ? '已恢复为最新版本' : '目标内容已是当前版本', data.created ? 'success' : 'info');
        await invalidate(qk.prompts(projectId));
        await loadVersion(data.versionId);
      },
      onError: (error) => push((error as Error).message, 'error'),
    },
  );

  const createPrompt = useApiMutation(
    (client, value: { name: string; description?: string; label?: string; content?: string }) => client.post(`/v1/projects/${projectId}/prompts`, value),
    {
      invalidate: () => [qk.prompts(projectId)],
      onSuccess: async (result) => {
        setCreateOpen(false);
        setForm({ name: '', description: '', label: 'A', content: '' });
        push('提示词已创建', 'success');
        await invalidate(qk.prompts(projectId));
        const created = result as { promptId: string };
        const refreshed = await getClient();
        const list = await refreshed.get<{ prompts: Prompt[] }>(`/v1/projects/${projectId}/prompts`);
        const prompt = list.prompts.find((item) => item.promptId === created.promptId);
        const latest = prompt?.variants[0]?.latestVersionId;
        if (latest) await loadVersion(latest);
      },
      onError: (error) => push((error as Error).message, 'error'),
    },
  );

  const addBranch = useApiMutation(
    (client, value: { promptId: string; label: string; content: string }) =>
      client.post(`/v1/projects/${projectId}/prompts/${value.promptId}/variants`, { label: value.label, content: value.content }),
    {
      invalidate: () => [qk.prompts(projectId)],
      onSuccess: async (result) => {
        setBranchOpen(false);
        setBranchForm({ label: '', content: '' });
        push('分支已创建', 'success');
        const data = result as { versionId: string };
        await invalidate(qk.prompts(projectId));
        await loadVersion(data.versionId);
      },
      onError: (error) => push((error as Error).message, 'error'),
    },
  );

  const variables = useMemo(() => {
    const found = new Set<string>();
    for (const match of draft.matchAll(VARIABLE_PATTERN)) found.add(match[1]);
    return [...found].sort();
  }, [draft]);

  const dirty = version ? draft !== version.content : false;

  async function compare() {
    if (picked.length !== 2) return;
    try {
      const client = await getClient();
      const result = await client.get<PromptDiff>(`/v1/projects/${projectId}/prompt-diff`, { query: { left: picked[0], right: picked[1] } });
      setDiff(result);
    } catch (error) {
      push((error as Error).message, 'error');
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>提示词实验室</h1>
          <div className="sub">版本不可变；编辑产生新版本，历史运行继续引用旧快照。</div>
        </div>
        <span className="spacer" />
        <div className="sticky-actions">
          <Button onClick={() => setCreateOpen(true)}>新建提示词</Button>
          <Button
            variant="primary"
            disabled={!currentVariant || !draft.trim() || !dirty}
            loading={saveVersion.isPending}
            onClick={() =>
              currentVariant &&
              selected &&
              saveVersion.mutate({ promptId: selected.promptId, variantId: selected.variantId, label: currentVariant.label, content: draft })
            }
          >
            保存为新版本
          </Button>
        </div>
      </header>

      {prompts.isError ? <ErrorNotice error={prompts.error} onRetry={() => prompts.refetch()} /> : null}

      {prompts.data && !prompts.data.prompts.length ? (
        <Card>
          <EmptyState title="还没有提示词" description="创建提示词并为每个分支维护独立版本。" action={<Button variant="primary" onClick={() => setCreateOpen(true)}>新建提示词</Button>} />
        </Card>
      ) : (
        <div className="split-view">
          <Card title="资产树" flush>
            <div className="list" style={{ padding: 8 }}>
              {prompts.data?.prompts.map((prompt) => (
                <div key={prompt.promptId}>
                  <div className="row" style={{ padding: '6px 10px' }}>
                    <span style={{ fontWeight: 600 }} className="truncate">{prompt.name}</span>
                    <span className="spacer" />
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={() => {
                        setBranchOpen(true);
                        setBranchForm({ label: '', content: '' });
                        setSelected({ promptId: prompt.promptId, variantId: prompt.variants[0]?.variantId ?? '' });
                      }}
                      title="新增分支"
                    >
                      ＋
                    </Button>
                  </div>
                  {prompt.variants.map((variant) => (
                    <button
                      key={variant.variantId}
                      className={`list-item tree-indent ${selected?.variantId === variant.variantId ? 'active' : ''}`}
                      onClick={() => variant.latestVersionId && loadVersion(variant.latestVersionId)}
                    >
                      <Badge tone="accent">{variant.label}</Badge>
                      <span className="small dim">v{variant.latestVersionNumber ?? '—'}</span>
                      <span className="spacer" />
                      <span className="small dim">{variant.versions.length} 版</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </Card>

          <div className="stack">
            {version ? (
              <>
                <Card
                  title={
                    <span className="row" style={{ gap: 8 }}>
                      {version.promptName} <Badge tone="accent">{version.label}</Badge>
                      <span className="dim small">当前 v{version.versionNumber}</span>
                      {dirty ? <Badge tone="warn">未保存</Badge> : null}
                    </span>
                  }
                  subtitle={<span className="mono">{version.contentHash.slice(0, 22)}… · {formatDateTime(version.createdAt)}</span>}
                  actions={
                    <>
                      <CopyButton value={version.versionId} label="复制版本 ID" small />
                      <Button size="small" onClick={() => loadVersion(version.versionId)} disabled={!dirty}>
                        放弃修改
                      </Button>
                    </>
                  }
                >
                  <div className="stack">
                    <div className="editor-wrap">
                      <div className="editor-gutter" aria-hidden>
                        {Array.from({ length: Math.max(1, draft.split('\n').length) }, (_, index) => (
                          <div key={index}>{index + 1}</div>
                        ))}
                      </div>
                      <textarea
                        className="editor-area"
                        value={draft}
                        spellCheck={false}
                        onChange={(event) => setDraft(event.target.value)}
                        aria-label="提示词内容"
                        onKeyDown={(event) => {
                          if (event.key === 'Tab') {
                            event.preventDefault();
                            const target = event.currentTarget;
                            const start = target.selectionStart;
                            const end = target.selectionEnd;
                            const next = `${draft.slice(0, start)}  ${draft.slice(end)}`;
                            setDraft(next);
                            requestAnimationFrame(() => target.setSelectionRange(start + 2, start + 2));
                          }
                        }}
                      />
                    </div>
                    <div className="row">
                      <span className="small dim">变量：</span>
                      {variables.length ? variables.map((name) => <Badge key={name} tone="violet">{`{{${name}}}`}</Badge>) : <span className="small dim">无</span>}
                      <span className="spacer" />
                      <span className="small dim">{draft.length} 字符 · {draft.split('\n').length} 行</span>
                    </div>
                  </div>
                </Card>

                <Card
                  title="版本历史"
                  subtitle="勾选两个版本可对比"
                  actions={
                    <Button size="small" disabled={picked.length !== 2} onClick={compare}>
                      对比所选（{picked.length}/2）
                    </Button>
                  }
                  flush
                >
                  <div className="list" style={{ padding: 8 }}>
                    {currentVariant?.versions.map((item) => (
                      <VersionRow
                        key={item.versionId}
                        version={item}
                        active={item.versionId === version.versionId}
                        picked={picked.includes(item.versionId)}
                        onOpen={() => loadVersion(item.versionId)}
                        onRestore={() => restoreVersion.mutate(item.versionId)}
                        restoring={restoreVersion.isPending}
                        onPick={() =>
                          setPicked((current) =>
                            current.includes(item.versionId) ? current.filter((id) => id !== item.versionId) : [...current, item.versionId].slice(-2),
                          )
                        }
                      />
                    ))}
                  </div>
                </Card>
              </>
            ) : (
              <Card>
                <div className="row" style={{ justifyContent: 'center', padding: 30 }}>
                  {loadingVersion ? <span className="spinner" /> : '选择左侧分支开始编辑'}
                </div>
              </Card>
            )}
          </div>
        </div>
      )}

      <Modal
        open={createOpen}
        title="新建提示词"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button
              variant="primary"
              loading={createPrompt.isPending}
              disabled={!form.name.trim()}
              onClick={() => createPrompt.mutate({ name: form.name.trim(), description: form.description || undefined, label: form.label || 'A', content: form.content })}
            >
              创建
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="名称">
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="客服回复主提示词" />
          </Field>
          <Field label="描述（可选）">
            <Input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </Field>
          <div className="row">
            <Field label="首个分支标签">
              <Input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} style={{ width: 120 }} />
            </Field>
          </div>
          <Field label="首个分支内容（可选）" hint="留空则创建空提示词，之后在编辑器中保存首个版本。">
            <Textarea className="mono" value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} placeholder="你是专业客服……用户问题：{{question}}" />
          </Field>
          {createPrompt.error ? <ErrorNotice error={createPrompt.error} /> : null}
        </div>
      </Modal>

      <Modal
        open={branchOpen}
        title={`新增分支 · ${currentPrompt?.name ?? ''}`}
        onClose={() => setBranchOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBranchOpen(false)}>取消</Button>
            <Button
              variant="primary"
              loading={addBranch.isPending}
              disabled={!branchForm.label.trim() || !branchForm.content.trim()}
              onClick={() =>
                currentPrompt &&
                addBranch.mutate({ promptId: currentPrompt.promptId, label: branchForm.label.trim(), content: branchForm.content })
              }
            >
              创建分支
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="分支标签" hint="如 A / B / 安慰版">
            <Input value={branchForm.label} onChange={(event) => setBranchForm({ ...branchForm, label: event.target.value })} />
          </Field>
          <Field label="分支内容">
            <Textarea className="mono" value={branchForm.content} onChange={(event) => setBranchForm({ ...branchForm, content: event.target.value })} />
          </Field>
          {addBranch.error ? <ErrorNotice error={addBranch.error} /> : null}
        </div>
      </Modal>

      <Modal open={Boolean(diff)} title="版本对比" wide onClose={() => setDiff(null)} footer={<Button onClick={() => setDiff(null)}>关闭</Button>}>
        {diff ? <PromptDiffView diff={diff} /> : null}
      </Modal>
    </div>
  );
}

function VersionRow({
  version,
  active,
  picked,
  onOpen,
  onPick,
  onRestore,
  restoring,
}: {
  version: PromptVersionSummary;
  active: boolean;
  picked: boolean;
  onOpen: () => void;
  onPick: () => void;
  onRestore: () => void;
  restoring: boolean;
}) {
  return (
    <div className={`list-item ${active ? 'active' : ''}`} style={{ cursor: 'default' }}>
      <input type="checkbox" checked={picked} onChange={onPick} aria-label={`选择版本 v${version.versionNumber}`} />
      <button className="btn ghost small" onClick={onOpen} style={{ padding: 0 }}>
        v{version.versionNumber}
      </button>
      <span className="mono small dim">{version.contentHash.slice(0, 16)}…</span>
      <span className="spacer" />
      <span className="small dim">{formatDateTime(version.createdAt)}</span>
      {version.variables.length ? <Badge tone="violet">{version.variables.length} 变量</Badge> : null}
      {!active ? (
        <Button size="small" variant="ghost" loading={restoring} onClick={onRestore}>
          恢复
        </Button>
      ) : null}
    </div>
  );
}
