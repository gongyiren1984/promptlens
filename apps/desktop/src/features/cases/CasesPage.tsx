import { useState } from 'react';
import type {
  CasePage,
  ImportCommitResult,
  ImportPreview,
  LibraryEntryDetail,
  LibraryEntrySummary,
  LibraryImportResult,
  ModelProfile,
  TestSet,
} from '@promptlens/contracts';
import { getClient } from '../../api/bridge';
import { qk, useApiMutation, useApiQuery, useQueryInvalidator } from '../../api/hooks';
import { Badge, Button, Card, EmptyState, ErrorNotice, Field, IdText, Input, Modal, Select, Tabs, Textarea, formatDateTime, useToast } from '../../components/ui';
import { DataTable, type Column } from '../../components/table';

const PAGE_SIZE = 50;

export function CasesPage({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<'cases' | 'testsets' | 'library'>('cases');
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>用例库</h1>
          <div className="sub">导入采用两阶段预览；用例内容寻址去重，测试集版本冻结后运行快照可追溯。</div>
        </div>
      </header>
      <Tabs
        tabs={[
          { id: 'cases', label: '用例' },
          { id: 'testsets', label: '测试集' },
          { id: 'library', label: '跨项目库' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'cases' ? <CasesView projectId={projectId} /> : tab === 'testsets' ? <TestSetsView projectId={projectId} /> : <LibraryView projectId={projectId} />}
    </div>
  );
}

function CasesView({ projectId }: { projectId: string }) {
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [page, setPage] = useState(0);
  const query = useApiQuery<CasePage>(
    qk.cases(projectId, applied, page),
    (client) => client.get(`/v1/projects/${projectId}/cases`, { query: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, q: applied } }),
  );
  const [importOpen, setImportOpen] = useState(false);

  const columns: Array<Column<CasePage['cases'][number]>> = [
    { key: 'id', header: '用例 ID', render: (row) => <IdText value={row.caseVersionId} chars={12} /> },
    {
      key: 'input',
      header: '输入',
      render: (row) => (
        <span className="truncate" style={{ maxWidth: 420, display: 'inline-block' }} title={JSON.stringify(row.input)}>
          {typeof row.input === 'string' ? row.input : JSON.stringify(row.input)}
        </span>
      ),
    },
    {
      key: 'expected',
      header: '期望输出',
      render: (row) => <span className="small dim truncate" style={{ maxWidth: 220, display: 'inline-block' }}>{row.expected == null ? '—' : typeof row.expected === 'string' ? row.expected : JSON.stringify(row.expected)}</span>,
    },
    {
      key: 'meta',
      header: '元数据',
      render: (row) => (row.meta ? <Badge tone="info">{Object.keys(row.meta).join(', ') || '{}'}</Badge> : <span className="dim">—</span>),
    },
  ];

  const totalPages = query.data ? Math.max(1, Math.ceil(query.data.total / PAGE_SIZE)) : 1;

  return (
    <div className="stack">
      <div className="toolbar">
        <Input
          placeholder="搜索输入内容或用例 ID"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              setApplied(search.trim());
              setPage(0);
            }
          }}
          style={{ minWidth: 260 }}
        />
        <Button
          onClick={() => {
            setApplied(search.trim());
            setPage(0);
          }}
        >
          搜索
        </Button>
        <span className="spacer" />
        <span className="small dim">{query.data ? `共 ${query.data.total} 条` : ''}</span>
        <Button variant="primary" onClick={() => setImportOpen(true)}>
          导入用例
        </Button>
      </div>

      {query.isError ? <ErrorNotice error={query.error} onRetry={() => query.refetch()} /> : null}

      <Card flush>
        <DataTable
          columns={columns}
          rows={query.data?.cases ?? []}
          rowKey={(row) => row.caseVersionId}
          emptyText={query.isLoading ? '加载中…' : '还没有用例，点击右上角导入。'}
          maxHeight={520}
        />
        <div className="row" style={{ padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
          <Button size="small" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>
            上一页
          </Button>
          <span className="small dim">
            第 {page + 1} / {totalPages} 页
          </span>
          <Button size="small" disabled={page + 1 >= totalPages} onClick={() => setPage((value) => value + 1)}>
            下一页
          </Button>
        </div>
      </Card>

      <ImportModal projectId={projectId} open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}

function ImportModal({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const { push } = useToast();
  const invalidate = useQueryInvalidator();
  const [format, setFormat] = useState<'csv' | 'json' | 'jsonl'>('csv');
  const [text, setText] = useState('');
  const [setName, setSetName] = useState('');
  const [mapping, setMapping] = useState({ input: '', expected: '', meta: '' });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [duplicatePolicy, setDuplicatePolicy] = useState<'reuse' | 'skip'>('reuse');
  const models = useApiQuery<{ models: ModelProfile[] }>(qk.models(projectId), (client) => client.get(`/v1/projects/${projectId}/models`));
  const [genModel, setGenModel] = useState('');
  const [genInstruction, setGenInstruction] = useState('');
  const [genCount, setGenCount] = useState(10);
  const [generating, setGenerating] = useState(false);
  const [genMeta, setGenMeta] = useState<{ name: string; produced: number; amount: string | null; currency: string | null } | null>(null);

  const commit = useApiMutation(
    (client, value: { previewId: string; setName: string; duplicatePolicy: string }) =>
      client.post<ImportCommitResult>(`/v1/projects/${projectId}/cases/import/commit`, value),
    {
      invalidate: () => [qk.cases(projectId, '', 0), qk.testSets(projectId)],
      onSuccess: async (result) => {
        push(
          result.skippedAll
            ? '全部记录已存在，未新增用例'
            : `导入完成：新增 ${result.imported ?? 0}，复用 ${result.duplicates ?? 0}，测试集共 ${result.caseCount ?? 0} 条`,
          'success',
        );
        await invalidate(qk.cases(projectId, '', 0));
        await invalidate(qk.testSets(projectId));
        setPreview(null);
        setText('');
        onClose();
      },
      onError: (error) => push((error as Error).message, 'error'),
    },
  );

  async function runPreview(nextMapping = mapping) {
    if (!text.trim()) {
      push('请先粘贴或选择文件内容', 'warn');
      return;
    }
    setPreviewing(true);
    try {
      const client = await getClient();
      const result = await client.post<ImportPreview>(`/v1/projects/${projectId}/cases/import/preview`, {
        text,
        format,
        setName: setName || null,
        mapping: format === 'csv' && nextMapping.input ? nextMapping : null,
      });
      setPreview(result);
      if (result.errorCount) push(`预览完成：${result.errorCount} 条校验失败`, 'warn');
    } catch (error) {
      push((error as Error).message, 'error');
    } finally {
      setPreviewing(false);
    }
  }

  async function generate() {
    const modelId = genModel || models.data?.models.find((model) => model.latest)?.latest?.modelConfigVersionId;
    if (!modelId) {
      push('请先在模型中心配置可用模型', 'warn');
      return;
    }
    if (!genInstruction.trim()) {
      push('请填写生成说明', 'warn');
      return;
    }
    setGenerating(true);
    try {
      const client = await getClient();
      const result = await client.post<{
        preview: ImportPreview;
        records: Array<Record<string, unknown>>;
        generator: { name: string; produced: number };
        cost: { amount: string | null; currency: string | null };
      }>(`/v1/projects/${projectId}/cases/generate`, {
        modelConfigVersionId: modelId,
        instruction: genInstruction.trim(),
        count: genCount,
        setName: setName || 'AI 生成集',
      });
      setPreview(result.preview);
      setFormat('jsonl');
      setText(result.records.map((record) => JSON.stringify(record)).join('\n'));
      setGenMeta({
        name: result.generator.name,
        produced: result.generator.produced,
        amount: result.cost.amount,
        currency: result.cost.currency,
      });
      if (!result.generator.produced) push('模型没有返回可用候选，请调整说明后重试', 'warn');
      else push(`已生成 ${result.generator.produced} 条候选，确认后提交`, 'success');
    } catch (error) {
      push((error as Error).message, 'error');
    } finally {
      setGenerating(false);
    }
  }

  function onFile(file: File | null) {
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext === 'json') setFormat('json');
    else if (ext === 'jsonl' || ext === 'ndjson') setFormat('jsonl');
    else setFormat('csv');
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ''));
    reader.readAsText(file);
  }

  return (
    <Modal
      open={open}
      title="导入用例"
      wide
      onClose={() => {
        setPreview(null);
        onClose();
      }}
      footer={
        <>
          <Button variant="ghost" onClick={() => { setPreview(null); onClose(); }}>
            取消
          </Button>
          {preview ? (
            <Button
              variant="primary"
              loading={commit.isPending}
              disabled={preview.errorCount > 0 || !setName.trim()}
              onClick={() => commit.mutate({ previewId: preview.previewId, setName: setName.trim(), duplicatePolicy })}
            >
              提交 {preview.validRecords} 条
            </Button>
          ) : (
            <Button variant="primary" loading={previewing} onClick={() => runPreview()}>
              生成预览
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        <Card title="AI 生成候选" subtitle="生成只产出候选，仍需预览与提交；调用成本按模型价格记录">
          <div className="row">
            <Field label="模型">
              <Select
                value={genModel || models.data?.models.find((model) => model.latest)?.latest?.modelConfigVersionId || ''}
                onChange={(event) => setGenModel(event.target.value)}
              >
                {(models.data?.models ?? []).filter((model) => model.latest).map((model) => (
                  <option key={model.profileId} value={model.latest!.modelConfigVersionId}>
                    {model.name}（{model.providerType}）
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="数量">
              <Input
                type="number"
                min={1}
                max={50}
                value={genCount}
                onChange={(event) => setGenCount(Math.max(1, Math.min(50, Number(event.target.value) || 1)))}
                style={{ width: 100 }}
              />
            </Field>
            <Field label="测试集名称">
              <Input value={setName} onChange={(event) => setSetName(event.target.value)} placeholder="AI 生成集" />
            </Field>
          </div>
          <Field label="生成说明" hint="描述业务场景、输入字段与需要覆盖的边界，例如：电商客服咨询物流进度，覆盖催单、丢件、改地址。">
            <Textarea rows={3} value={genInstruction} onChange={(event) => setGenInstruction(event.target.value)} />
          </Field>
          <div className="row">
            <Button onClick={generate} loading={generating}>生成候选用例</Button>
            {genMeta ? (
              <span className="small dim">
                {genMeta.name} 生成 {genMeta.produced} 条
                {genMeta.amount === null ? ' · 成本未知' : ` · 成本 ${genMeta.amount} ${genMeta.currency ?? ''}`}
              </span>
            ) : null}
          </div>
        </Card>

        <div className="row">
          <Field label="格式">
            <Select value={format} onChange={(event) => { setFormat(event.target.value as typeof format); setPreview(null); }}>
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
              <option value="jsonl">JSONL</option>
            </Select>
          </Field>
          <Field label="测试集名称">
            <Input value={setName} onChange={(event) => setSetName(event.target.value)} placeholder="基础集" />
          </Field>
          <Field label="文件">
            <input type="file" accept=".csv,.json,.jsonl,.ndjson" onChange={(event) => onFile(event.target.files?.[0] ?? null)} />
          </Field>
        </div>

        <Field label="内容" hint="CSV 需包含 input 或 input_json 列；JSON 支持数组或 { cases: [] }。">
          <Textarea
            className="mono"
            rows={8}
            value={text}
            onChange={(event) => { setText(event.target.value); setPreview(null); }}
            placeholder={'input,expected_json\n订单什么时候到？,"订单预计今天送达"'}
          />
        </Field>

        {preview ? (
          <>
            <div className="grid cols-4">
              <div className="stat"><span className="label">总记录</span><span className="value">{preview.totalRecords}</span></div>
              <div className="stat"><span className="label">可导入</span><span className="value">{preview.validRecords}</span></div>
              <div className="stat"><span className="label">重复</span><span className="value">{preview.duplicateRecords}</span></div>
              <div className="stat"><span className="label">错误</span><span className="value" style={{ color: preview.errorCount ? 'var(--red)' : undefined }}>{preview.errorCount}</span></div>
            </div>

            {format === 'csv' ? (
              <Card title="字段映射" subtitle="指定 CSV 列到 input / expected / meta">
                <div className="row">
                  {(['input', 'expected', 'meta'] as const).map((field) => (
                    <Field key={field} label={field}>
                      <Select
                        value={mapping[field]}
                        onChange={(event) => setMapping({ ...mapping, [field]: event.target.value })}
                      >
                        <option value="">（不映射）</option>
                        {preview.columns.map((column) => (
                          <option key={column} value={column}>{column}</option>
                        ))}
                      </Select>
                    </Field>
                  ))}
                  <Button onClick={() => runPreview(mapping)} loading={previewing}>
                    重新预览
                  </Button>
                </div>
              </Card>
            ) : null}

            {preview.errors.length ? (
              <Card title={`校验错误（前 ${preview.errors.length} 条）`} flush>
                <DataTable
                  columns={[
                    { key: 'row', header: '行', render: (row: { row: number; message: string }) => <span className="mono">{row.row}</span> },
                    { key: 'message', header: '原因', render: (row: { row: number; message: string }) => row.message },
                  ]}
                  rows={preview.errors}
                  rowKey={(row) => String(row.row)}
                  maxHeight={180}
                />
              </Card>
            ) : null}

            <Card title="样例（前 10 条）" flush>
              <DataTable
                columns={[
                  { key: 'input', header: '输入', render: (row) => <span className="truncate" style={{ maxWidth: 380, display: 'inline-block' }}>{typeof row.input === 'string' ? row.input : JSON.stringify(row.input)}</span> },
                  { key: 'expected', header: '期望', render: (row) => <span className="small dim">{row.expected == null ? '—' : JSON.stringify(row.expected)}</span> },
                  { key: 'meta', header: '元数据', render: (row) => <span className="small dim">{row.meta ? JSON.stringify(row.meta) : '—'}</span> },
                ]}
                rows={preview.sample}
                rowKey={(row) => JSON.stringify(row.input)}
                maxHeight={240}
              />
            </Card>

            <Field label="重复策略" hint="reuse 复用已有用例；skip 跳过全部重复记录。">
              <Select value={duplicatePolicy} onChange={(event) => setDuplicatePolicy(event.target.value as typeof duplicatePolicy)}>
                <option value="reuse">复用已有用例（保留内容不变）</option>
                <option value="skip">跳过重复记录</option>
              </Select>
            </Field>
            {preview.errorCount > 0 ? <div className="notice error">存在校验失败的记录，整体提交会被拒绝。请修正后重新生成预览。</div> : null}
          </>
        ) : null}

        {commit.error ? <ErrorNotice error={commit.error} /> : null}
      </div>
    </Modal>
  );
}

function TestSetsView({ projectId }: { projectId: string }) {
  const { push } = useToast();
  const invalidate = useQueryInvalidator();
  const sets = useApiQuery<{ testSets: TestSet[] }>(qk.testSets(projectId), (client) => client.get(`/v1/projects/${projectId}/testsets`));
  const [openSet, setOpenSet] = useState<TestSet | null>(null);
  const [promoteSet, setPromoteSet] = useState<TestSet | null>(null);
  const [promoteName, setPromoteName] = useState('');
  const [license, setLicense] = useState('');
  const [sensitive, setSensitive] = useState(false);
  const promote = useApiMutation<LibraryEntrySummary, { versionId: string; setName: string; license: string; sensitive: boolean }>(
    (client, body) => client.post(`/v1/projects/${projectId}/testsets/${body.versionId}/promote`, body),
    {
      invalidate: () => [qk.library()],
      onSuccess: (entry) => {
        push('已提升到跨项目用例库', 'success', `${entry.setName} 库版本 v${entry.version} · ${entry.caseCount} 条`);
        setPromoteSet(null);
      },
      onError: (error) => push('提升失败', 'error', error instanceof Error ? error.message : String(error)),
    },
  );

  if (sets.isError) return <ErrorNotice error={sets.error} onRetry={() => sets.refetch()} />;
  if (sets.data && !sets.data.testSets.length) {
    return <Card><EmptyState title="还没有测试集" description="导入用例时会按测试集名称自动创建并冻结版本。" /></Card>;
  }

  function openPromote(set: TestSet) {
    setPromoteSet(set);
    setPromoteName(set.name);
    setLicense('');
    setSensitive(false);
  }

  return (
    <div className="stack">
      <div className="grid cols-2">
        {sets.data?.testSets.map((set) => (
          <Card
            key={set.testSetId}
            title={set.name}
            subtitle={`${set.caseCount} 条用例 · 最新 v${set.latestVersionNumber ?? '—'}`}
            actions={
              <div className="row">
                <Button size="small" onClick={() => setOpenSet(set)}>版本</Button>
                <Button size="small" variant="ghost" disabled={!set.latestVersionId} onClick={() => openPromote(set)}>提升到用例库</Button>
              </div>
            }
          >
            <dl className="kv">
              <dt>最新版本</dt>
              <dd className="mono">{set.latestVersionId ?? '—'}</dd>
              <dt>内容哈希</dt>
              <dd className="mono">{set.contentHash ? `${set.contentHash.slice(0, 26)}…` : '—'}</dd>
              <dt>版本数</dt>
              <dd>{set.versions.length}</dd>
            </dl>
            <div className="small dim" style={{ marginTop: 8 }}>
              冻结提示：运行快照固定测试集版本；后续导入会生成新版本，不改变历史运行。
            </div>
          </Card>
        ))}
      </div>

      <Modal open={Boolean(openSet)} title={`测试集版本 · ${openSet?.name ?? ''}`} onClose={() => setOpenSet(null)} footer={<Button onClick={() => setOpenSet(null)}>关闭</Button>}>
        <DataTable
          columns={[
            { key: 'version', header: '版本', render: (row) => <span className="mono">v{row.versionNumber}</span> },
            { key: 'id', header: '版本 ID', render: (row) => <IdText value={row.testSetVersionId} chars={14} /> },
            { key: 'count', header: '用例数', align: 'right', render: (row) => row.caseCount },
            {
              key: 'origin',
              header: '来源',
              render: (row) =>
                row.origin ? (
                  <span className="small">
                    <Badge tone={row.origin.sensitive ? 'warn' : 'info'}>跨项目库 v{row.origin.libraryVersion}</Badge>{' '}
                    <span className="dim">{row.origin.sourceProjectName ?? row.origin.sourceProjectId}</span>
                  </span>
                ) : (
                  <span className="dim small">本项目</span>
                ),
            },
            { key: 'created', header: '创建时间', render: (row) => <span className="small">{formatDateTime(row.createdAt)}</span> },
          ]}
          rows={openSet?.versions ?? []}
          rowKey={(row) => row.testSetVersionId}
          maxHeight={360}
        />
      </Modal>

      <Modal
        open={Boolean(promoteSet)}
        title={`提升到用例库 · ${promoteSet?.name ?? ''}`}
        onClose={() => setPromoteSet(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPromoteSet(null)}>取消</Button>
            <Button
              variant="primary"
              loading={promote.isPending}
              disabled={!promoteName.trim()}
              onClick={() =>
                promoteSet?.latestVersionId &&
                promote.mutate({ versionId: promoteSet.latestVersionId, setName: promoteName.trim(), license: license.trim(), sensitive })
              }
            >
              提升 v{promoteSet?.latestVersionNumber ?? '—'}
            </Button>
          </>
        }
      >
        <div className="stack">
          <div className="notice info">提升会复制一份不可变快照到本机全局用例库；源项目移动或删除不影响快照。</div>
          <Field label="库中名称" hint="同名测试集会递增库版本，历史快照保持不变。">
            <Input value={promoteName} onChange={(event) => setPromoteName(event.target.value)} />
          </Field>
          <Field label="来源许可证" hint="如内部使用、CC-BY-4.0、MIT；留空会在复用时提示缺失。">
            <Input value={license} onChange={(event) => setLicense(event.target.value)} placeholder="internal-only" />
          </Field>
          <label className="row small" style={{ gap: 8 }}>
            <input type="checkbox" checked={sensitive} onChange={(event) => setSensitive(event.target.checked)} />
            包含敏感数据（复用前会显示标记并告警）
          </label>
        </div>
      </Modal>
    </div>
  );
}

function LibraryView({ projectId }: { projectId: string }) {
  const { push } = useToast();
  const invalidate = useQueryInvalidator();
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [detail, setDetail] = useState<LibraryEntryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const library = useApiQuery<{ total: number; entries: LibraryEntrySummary[] }>(
    qk.library(applied),
    (client) => client.get('/v1/library', { query: { q: applied } }),
  );
  const importEntry = useApiMutation<LibraryImportResult, string>(
    (client, libraryId) => client.post(`/v1/projects/${projectId}/library/${libraryId}/import`, {}),
    {
      invalidate: () => [qk.cases(projectId, '', 0), qk.testSets(projectId), qk.library(applied)],
      onSuccess: (result) => {
        push(`已导入到 ${result.testSetName}`, 'success', `${result.newVersion ? `新版本 v${result.versionNumber}` : '复用已有版本'} · ${result.caseCount} 条用例`);
        for (const warning of result.warnings) push(warning.code, 'warn', warning.message);
      },
      onError: (error) => push('导入失败', 'error', error instanceof Error ? error.message : String(error)),
    },
  );

  async function openDetail(entry: LibraryEntrySummary) {
    setDetailLoading(true);
    try {
      const client = await getClient();
      setDetail(await client.get<LibraryEntryDetail>(`/v1/library/${entry.libraryId}`));
    } catch (error) {
      push('读取快照失败', 'error', error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <Input
          placeholder="搜索测试集、来源项目或库 ID"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') setApplied(search.trim());
          }}
          style={{ minWidth: 280 }}
        />
        <Button onClick={() => setApplied(search.trim())}>搜索</Button>
        <span className="spacer" />
        <span className="small dim">{library.data ? `共 ${library.data.total} 个快照` : ''}</span>
        <Button variant="ghost" onClick={() => library.refetch()}>刷新</Button>
      </div>

      {library.isError ? <ErrorNotice error={library.error} onRetry={() => library.refetch()} /> : null}

      {library.data && !library.data.entries.length ? (
        <Card>
          <EmptyState
            title="跨项目用例库为空"
            description="在「测试集」页把冻结版本提升到用例库，即可在其他项目中复用固定快照。"
          />
        </Card>
      ) : null}

      <div className="grid cols-2">
        {(library.data?.entries ?? []).map((entry) => (
          <Card
            key={entry.libraryId}
            title={`${entry.setName} · 库 v${entry.version}`}
            subtitle={`${entry.caseCount} 条用例 · 来自 ${entry.source.projectName ?? entry.source.projectId}`}
            actions={
              <div className="row">
                <Button size="small" variant="ghost" onClick={() => openDetail(entry)}>详情</Button>
                <Button size="small" variant="primary" loading={importEntry.isPending} onClick={() => importEntry.mutate(entry.libraryId)}>
                  导入本项目
                </Button>
              </div>
            }
          >
            <div className="row small" style={{ flexWrap: 'wrap' }}>
              <Badge tone="info">{entry.license ?? '未声明许可证'}</Badge>
              {entry.sensitive ? <Badge tone="warn">敏感数据</Badge> : null}
              <span className="mono dim">{entry.contentHash.slice(0, 22)}…</span>
            </div>
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>来源测试集版本</dt>
              <dd className="mono">{entry.source.testSetVersionId}</dd>
              <dt>入库时间</dt>
              <dd className="small">{formatDateTime(entry.createdAt)}</dd>
            </dl>
            <div className="small dim" style={{ marginTop: 8 }}>
              导入会复制为固定版本并记录来源；库中新增版本不会改变历史测试集。
            </div>
          </Card>
        ))}
      </div>

      <Modal
        open={Boolean(detail) || detailLoading}
        title={detail ? `快照详情 · ${detail.setName} v${detail.version}` : '读取快照…'}
        wide
        onClose={() => setDetail(null)}
        footer={<Button onClick={() => setDetail(null)}>关闭</Button>}
      >
        {detail ? (
          <div className="stack">
            <div className="row small" style={{ flexWrap: 'wrap' }}>
              <Badge tone="info">{detail.license ?? '未声明许可证'}</Badge>
              {detail.sensitive ? <Badge tone="warn">敏感数据</Badge> : null}
              <span className="dim">来源 {detail.source.projectName ?? detail.source.projectId}</span>
              <span className="mono dim">{detail.contentHash}</span>
            </div>
            <DataTable
              columns={[
                { key: 'input', header: '输入', render: (row) => <span className="truncate" style={{ maxWidth: 380, display: 'inline-block' }}>{JSON.stringify(row.input)}</span> },
                { key: 'expected', header: '期望', render: (row) => <span className="small dim">{row.expected == null ? '—' : JSON.stringify(row.expected)}</span> },
                { key: 'meta', header: '元数据', render: (row) => <span className="small dim">{row.meta == null ? '—' : JSON.stringify(row.meta)}</span> },
              ]}
              rows={detail.cases}
              rowKey={(row) => JSON.stringify(row.input)}
              maxHeight={420}
            />
          </div>
        ) : (
          <div className="row" style={{ justifyContent: 'center', padding: 24 }}><span className="spinner" /></div>
        )}
      </Modal>
    </div>
  );
}
