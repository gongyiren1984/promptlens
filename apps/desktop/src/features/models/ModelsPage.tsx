import { useEffect, useState } from 'react';
import type { ModelConfigVersion, ModelConnectionTest, ModelLibrary, ModelLibraryEntry, ModelProbeResult, ModelProfile, ProjectListResult } from '@promptlens/contracts';
import { getClient } from '../../api/bridge';
import { qk, useApiMutation, useApiQuery } from '../../api/hooks';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
  formatDateTime,
  useToast,
} from '../../components/ui';
import { DataTable } from '../../components/table';
import { navigate, projectPath } from '../../app/router';
import { isCredentialRef } from '../../lib/credential';

export function ModelsPage() {
  const { push } = useToast();
  const projects = useApiQuery<ProjectListResult>(qk.projects(), (client) => client.get('/v1/projects'));
  const [projectId, setProjectId] = useState(() => localStorage.getItem('promptlens.modelProject') ?? '');
  const [addOpen, setAddOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [form, setForm] = useState({
    name: '',
    providerType: 'mock' as 'mock' | 'openai_compatible',
    modelId: '',
    baseUrl: '',
    credentialRef: '',
    params: '{}',
    currency: 'USD',
    unit: 'per_million_tokens' as 'per_million_tokens' | 'per_token' | 'per_request',
    input: '',
    output: '',
    perRequest: '',
  });
  const [versionsOf, setVersionsOf] = useState<ModelProfile | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<ModelProbeResult | null>(null);
  const [savingLibraryId, setSavingLibraryId] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);

  const library = useApiQuery<ModelLibrary>(qk.modelLibrary(), (client) => client.get('/v1/model-library'));
  const saveToLibrary = useApiMutation(
    (client, latest: ModelConfigVersion) =>
      client.post('/v1/model-library', {
        name: latest.name,
        providerType: latest.providerType,
        modelId: latest.modelId,
        baseUrl: latest.baseUrl,
        credentialRef: latest.credentialRef,
        params: latest.params,
        pricing: latest.pricing,
      }),
    {
      invalidate: () => [qk.modelLibrary()],
      onSuccess: () => {
        setSavingLibraryId(null);
        push('已保存到跨项目模型库', 'success');
      },
      onError: (error) => {
        setSavingLibraryId(null);
        push((error as Error).message, 'error');
      },
    },
  );
  const importFromLibrary = useApiMutation(
    (client, libraryId: string) => client.post(`/v1/projects/${projectId}/models/from-library`, { libraryId }),
    {
      invalidate: () => [qk.models(projectId), qk.modelLibrary()],
      onSuccess: () => {
        setImportingId(null);
        push('已导入到当前项目', 'success');
      },
      onError: (error) => {
        setImportingId(null);
        push((error as Error).message, 'error');
      },
    },
  );
  const deleteLibraryEntry = useApiMutation(
    (client, id: string) => client.delete(`/v1/model-library/${id}`),
    {
      invalidate: () => [qk.modelLibrary()],
      onSuccess: () => push('已从模型库移除', 'success'),
      onError: (error) => push((error as Error).message, 'error'),
    },
  );

  useEffect(() => {
    if (!projectId && projects.data?.projects.length) {
      const first = projects.data.projects[0].projectId;
      setProjectId(first);
      localStorage.setItem('promptlens.modelProject', first);
    }
  }, [projects.data, projectId]);

  const models = useApiQuery<{ models: ModelProfile[] }>(
    qk.models(projectId || 'none'),
    (client) => client.get(`/v1/projects/${projectId}/models`),
    { enabled: Boolean(projectId) },
  );

  const createModel = useApiMutation(
    async (client) => {
      let params: Record<string, unknown> = {};
      try {
        params = form.params.trim() ? JSON.parse(form.params) : {};
      } catch {
        throw new Error('参数必须是合法 JSON');
      }
      const pricing = form.unit
        ? {
            currency: form.currency,
            unit: form.unit,
            ...(form.unit === 'per_request' ? { perRequest: form.perRequest || '0' } : {}),
            ...(form.unit !== 'per_request' ? { input: form.input || '0', output: form.output || '0' } : {}),
          }
        : null;
      const typedRef = form.credentialRef.trim();
      if (form.providerType === 'openai_compatible' && !apiKey.trim() && typedRef && !isCredentialRef(typedRef)) {
        throw new Error('凭据引用需形如 env:VARIABLE 或 keychain:service[:account]；也可以直接在上方填写 API Key。');
      }
      let credentialRef = typedRef || null;
      if (form.providerType === 'openai_compatible' && apiKey.trim()) {
        const stored = await client.post<{ credentialRef: string }>('/v1/credentials/keychain', {
          key: apiKey.trim(),
          account: form.name.trim() || 'openai-compatible',
        });
        credentialRef = stored.credentialRef;
      }
      return client.post(`/v1/projects/${projectId}/models`, {
        name: form.name.trim(),
        providerType: form.providerType,
        modelId: form.modelId.trim(),
        baseUrl: form.providerType === 'openai_compatible' ? form.baseUrl.trim() || null : null,
        credentialRef,
        params,
        pricing,
      });
    },
    {
      invalidate: () => [qk.models(projectId)],
      onSuccess: () => {
        setAddOpen(false);
        setApiKey('');
        setForm({ ...form, name: '', modelId: '', baseUrl: '', credentialRef: '', params: '{}', input: '', output: '', perRequest: '' });
        push('模型配置已保存', 'success');
      },
      onError: (error) => push((error as Error).message, 'error'),
    },
  );

  async function testModel(versionId: string) {
    setTestingId(versionId);
    try {
      const client = await getClient();
      const result = await client.post<ModelConnectionTest>(`/v1/projects/${projectId}/models/${versionId}/test`);
      push(`连接成功：${result.latencyMs} ms · ${result.sample.slice(0, 40)}`, 'success');
    } catch (error) {
      push((error as Error).message, 'error');
    } finally {
      setTestingId(null);
    }
  }

  async function probeModel(versionId: string) {
    setProbingId(versionId);
    try {
      const client = await getClient();
      setProbeResult(await client.post<ModelProbeResult>(`/v1/projects/${projectId}/models/${versionId}/probe`));
    } catch (error) {
      push((error as Error).message, 'error');
    } finally {
      setProbingId(null);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>模型中心</h1>
          <div className="sub">凭据只保存 env: 或 keychain: 引用；价格未知时成本显示为未知，不按 0 计。</div>
        </div>
        <span className="spacer" />
        <div className="sticky-actions">
          <Select
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              localStorage.setItem('promptlens.modelProject', event.target.value);
            }}
            style={{ minWidth: 180 }}
          >
            <option value="">选择项目</option>
            {projects.data?.projects.map((project) => (
              <option key={project.projectId} value={project.projectId}>
                {project.name}
              </option>
            ))}
          </Select>
          <Button variant="primary" disabled={!projectId} onClick={() => setAddOpen(true)}>
            添加模型
          </Button>
        </div>
      </header>

      <Card
        title="跨项目模型库"
        subtitle="模型模板跨项目复用；凭据只保存 env:/keychain: 引用，不复制任何密钥明文"
        flush
      >
        {library.isError ? (
          <div style={{ padding: 14 }}>
            <ErrorNotice error={library.error} onRetry={() => library.refetch()} />
          </div>
        ) : !library.data?.entries.length ? (
          <div style={{ padding: 14 }} className="small dim">
            模型库为空。在下方项目模型卡片上点击「保存到模型库」，即可在其他项目中一键导入。
          </div>
        ) : (
          <DataTable
            columns={[
              {
                key: 'name',
                header: '名称',
                render: (entry: ModelLibraryEntry) => (
                  <span className="row" style={{ gap: 6 }}>
                    {entry.name}
                    <Badge tone={entry.providerType === 'mock' ? 'warn' : 'info'}>{entry.providerType}</Badge>
                  </span>
                ),
              },
              { key: 'model', header: '模型 ID', render: (entry: ModelLibraryEntry) => <span className="mono small">{entry.modelId}</span> },
              { key: 'credential', header: '凭据引用', render: (entry: ModelLibraryEntry) => <span className="mono small dim">{entry.credentialRef ?? '无'}</span> },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (entry: ModelLibraryEntry) => (
                  <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    <Button
                      size="small"
                      disabled={!projectId}
                      loading={importingId === entry.id}
                      onClick={() => {
                        setImportingId(entry.id);
                        importFromLibrary.mutate(entry.id);
                      }}
                    >
                      导入到当前项目
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      loading={deleteLibraryEntry.isPending && deleteLibraryEntry.variables === entry.id}
                      onClick={() => deleteLibraryEntry.mutate(entry.id)}
                    >
                      移除
                    </Button>
                  </span>
                ),
              },
            ]}
            rows={library.data?.entries ?? []}
            rowKey={(entry) => entry.id}
            maxHeight={260}
          />
        )}
      </Card>

      {!projectId ? (
        <Card>
          <EmptyState title="先选择项目" description="模型配置按项目版本化存储。" action={<Button onClick={() => navigate('/')}>去工作区</Button>} />
        </Card>
      ) : models.isError ? (
        <ErrorNotice error={models.error} onRetry={() => models.refetch()} />
      ) : models.data && !models.data.models.length ? (
        <Card>
          <EmptyState title="还没有模型" description="添加 mock 模型可离线验证流程；openai_compatible 需要自备兼容服务。" action={<Button variant="primary" onClick={() => setAddOpen(true)}>添加模型</Button>} />
        </Card>
      ) : (
        <div className="stack">
          {models.data?.models.map((model) => {
            const latest = model.latest;
            return (
              <Card
                key={model.profileId}
                title={
                  <span className="row" style={{ gap: 8 }}>
                    {model.name}
                    <Badge tone={model.providerType === 'mock' ? 'warn' : 'info'}>{model.providerType}</Badge>
                    <Badge tone="muted">v{latest?.versionNumber ?? '—'}</Badge>
                  </span>
                }
                subtitle={<span className="mono">{latest?.modelId ?? '—'}</span>}
                actions={
                  <>
                    <Button size="small" onClick={() => setVersionsOf(model)}>
                      版本（{model.versions.length}）
                    </Button>
                    {latest ? (
                      <Button
                        size="small"
                        loading={savingLibraryId === latest.modelConfigVersionId}
                        onClick={() => {
                          setSavingLibraryId(latest.modelConfigVersionId);
                          saveToLibrary.mutate(latest);
                        }}
                      >
                        保存到模型库
                      </Button>
                    ) : null}
                    {latest ? (
                      <Button size="small" loading={testingId === latest.modelConfigVersionId} onClick={() => testModel(latest.modelConfigVersionId)}>
                        连接测试
                      </Button>
                    ) : null}
                    {latest ? (
                      <Button size="small" loading={probingId === latest.modelConfigVersionId} onClick={() => probeModel(latest.modelConfigVersionId)}>
                        探测模型
                      </Button>
                    ) : null}
                  </>
                }
              >
                <div className="grid cols-4">
                  <div>
                    <div className="small dim">接入地址</div>
                    <div className="mono small">{latest?.baseUrl ?? '—'}</div>
                  </div>
                  <div>
                    <div className="small dim">凭据引用</div>
                    <div className="mono small">{latest?.credentialRef ?? '无（mock）'}</div>
                  </div>
                  <div>
                    <div className="small dim">价格</div>
                    <div className="small">
                      {latest?.pricing
                        ? `${latest.pricing.unit} · ${latest.pricing.currency} · ${
                            latest.pricing.unit === 'per_request' ? latest.pricing.perRequest : `in ${latest.pricing.input} / out ${latest.pricing.output}`
                          }`
                        : <Badge tone="warn">未知</Badge>}
                    </div>
                  </div>
                  <div>
                    <div className="small dim">内容哈希</div>
                    <div className="mono small">{latest ? `${latest.contentHash.slice(0, 18)}…` : '—'}</div>
                  </div>
                </div>
                {latest?.params && Object.keys(latest.params).length ? (
                  <pre className="code" style={{ marginTop: 10 }}>{JSON.stringify(latest.params, null, 2)}</pre>
                ) : null}
                <div className="row small dim" style={{ marginTop: 8 }}>
                  <span>更新时间 {formatDateTime(latest?.createdAt)}</span>
                  <span className="spacer" />
                  <Button size="small" variant="ghost" onClick={() => navigate(projectPath(projectId))}>
                    回到项目
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Modal
        open={addOpen}
        title="添加模型"
        wide
        onClose={() => setAddOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>取消</Button>
            <Button
              variant="primary"
              loading={createModel.isPending}
              disabled={
                !form.name.trim() ||
                !form.modelId.trim() ||
                Boolean(form.providerType === 'openai_compatible' && !apiKey.trim() && form.credentialRef.trim() && !isCredentialRef(form.credentialRef))
              }
              onClick={() => createModel.mutate()}
            >
              保存配置
            </Button>
          </>
        }
      >
        <div className="stack">
          <div className="grid cols-3">
            <Field label="名称（唯一）">
              <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="mock-a" />
            </Field>
            <Field label="提供方">
              <Select value={form.providerType} onChange={(event) => setForm({ ...form, providerType: event.target.value as typeof form.providerType })}>
                <option value="mock">mock（确定性，离线）</option>
                <option value="openai_compatible">openai_compatible</option>
              </Select>
            </Field>
            <Field label="模型 ID">
              <Input className="mono" value={form.modelId} onChange={(event) => setForm({ ...form, modelId: event.target.value })} placeholder="mock-large" />
            </Field>
          </div>
          {form.providerType === 'openai_compatible' ? (
            <>
              <div className="grid cols-3">
                <Field label="Base URL">
                  <Input className="mono" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
                </Field>
                <Field label="API Key" hint="自动写入 macOS 钥匙串，项目中只保存引用。无需密钥的本机服务可留空。">
                  <Input
                    className="mono"
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="sk-..."
                  />
                </Field>
                <Field label="凭据引用（高级）" hint="留空则使用 API Key；也可填 env:VAR 或 keychain:service[:account]。">
                  <Input className="mono" value={form.credentialRef} onChange={(event) => setForm({ ...form, credentialRef: event.target.value })} placeholder="env:OPENAI_API_KEY" />
                </Field>
              </div>
              {form.credentialRef.trim() && !apiKey.trim() && !isCredentialRef(form.credentialRef) ? (
                <div className="notice warn small">格式必须是 env:VARIABLE 或 keychain:service[:account]；或清空此字段直接填写 API Key。</div>
              ) : null}
            </>
          ) : null}
          <Field label="请求参数（JSON）">
            <Textarea className="mono" rows={4} value={form.params} onChange={(event) => setForm({ ...form, params: event.target.value })} placeholder={'{"temperature":0.2}'} />
          </Field>
          <div className="grid cols-4">
            <Field label="币种">
              <Select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}>
                <option value="USD">USD</option>
                <option value="CNY">CNY</option>
                <option value="EUR">EUR</option>
              </Select>
            </Field>
            <Field label="计价单位">
              <Select value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value as typeof form.unit })}>
                <option value="per_million_tokens">每百万 Token</option>
                <option value="per_token">每 Token</option>
                <option value="per_request">每次请求</option>
              </Select>
            </Field>
            {form.unit === 'per_request' ? (
              <Field label="单次价格">
                <Input className="mono" value={form.perRequest} onChange={(event) => setForm({ ...form, perRequest: event.target.value })} placeholder="0.002" />
              </Field>
            ) : (
              <>
                <Field label="输入价格">
                  <Input className="mono" value={form.input} onChange={(event) => setForm({ ...form, input: event.target.value })} placeholder="0.15" />
                </Field>
                <Field label="输出价格">
                  <Input className="mono" value={form.output} onChange={(event) => setForm({ ...form, output: event.target.value })} placeholder="0.60" />
                </Field>
              </>
            )}
          </div>
          {createModel.error ? <ErrorNotice error={createModel.error} /> : null}
        </div>
      </Modal>

      <Modal
        open={Boolean(probeResult)}
        title="模型列表探测"
        onClose={() => setProbeResult(null)}
        footer={<Button onClick={() => setProbeResult(null)}>关闭</Button>}
      >
        <div className="stack">
          <div className="row small" style={{ flexWrap: 'wrap', gap: 6 }}>
            <Badge tone="info">{probeResult?.adapterVersion}</Badge>
            <span className="dim">{probeResult?.models.length ?? 0} 个模型 · {probeResult?.latencyMs ?? 0} ms</span>
            <span className="dim">流式：{probeResult?.capabilities.streaming ? '支持' : '未支持'} · 上下文：{probeResult?.capabilities.maxContextTokens ?? '未知'}</span>
          </div>
          <DataTable
            columns={[
              { key: 'id', header: '模型 ID', render: (model) => <span className="mono small">{model.id}</span> },
              { key: 'owner', header: 'Owner', render: (model) => <span className="small dim">{model.ownedBy ?? '—'}</span> },
            ]}
            rows={probeResult?.models ?? []}
            rowKey={(model) => model.id}
            maxHeight={360}
          />
        </div>
      </Modal>

      <Modal
        open={Boolean(versionsOf)}
        title={`版本历史 · ${versionsOf?.name ?? ''}`}
        onClose={() => setVersionsOf(null)}
        footer={<Button onClick={() => setVersionsOf(null)}>关闭</Button>}
      >
        <DataTable
          columns={[
            { key: 'v', header: '版本', render: (version: ModelConfigVersion) => <span className="mono">v{version.versionNumber}</span> },
            { key: 'model', header: '模型 ID', render: (version: ModelConfigVersion) => <span className="mono small">{version.modelId}</span> },
            { key: 'hash', header: '内容哈希', render: (version: ModelConfigVersion) => <span className="mono small dim">{version.contentHash.slice(0, 16)}…</span> },
            { key: 'time', header: '创建', render: (version: ModelConfigVersion) => <span className="small">{formatDateTime(version.createdAt)}</span> },
            { key: 'copy', header: '', render: (version: ModelConfigVersion) => <CopyButton value={version.modelConfigVersionId} small /> },
          ]}
          rows={versionsOf?.versions ?? []}
          rowKey={(version) => version.modelConfigVersionId}
          maxHeight={360}
        />
      </Modal>
    </div>
  );
}
