import { useMemo, useState } from 'react';
import type { AppConfig, Capabilities, ProjectListResult, ProjectSummary, TrashEntry } from '@promptlens/contracts';
import { qk, useApiMutation, useApiQuery } from '../../api/hooks';
import { pickDirectory } from '../../api/bridge';
import { Badge, Button, Card, EmptyState, ErrorNotice, Field, Input, Modal, Stat, formatDateTime, useToast } from '../../components/ui';
import { navigate, projectPath } from '../../app/router';
import { joinPath, safeName } from '../../lib/paths';
import { useQueryClient } from '@tanstack/react-query';

export function WorkspacePage() {
  const queryClient = useQueryClient();
  const { push } = useToast();
  const projects = useApiQuery<ProjectListResult>(qk.projects(), (client) => client.get('/v1/projects'), { refetchInterval: 15_000 });
  const capabilities = useApiQuery<Capabilities>(qk.capabilities(), (client) => client.get('/v1/capabilities'), { staleTime: 30_000 });
  const appConfig = useApiQuery<AppConfig>(qk.appConfig(), (client) => client.get('/v1/app/config'));
  const trash = useApiQuery<{ entries: TrashEntry[] }>(['trash'], (client) => client.get('/v1/trash'), { refetchInterval: 30_000 });
  const restore = useApiMutation<{ project: ProjectSummary; restoredTo: string }, string>(
    (client, projectId) => client.post(`/v1/trash/${projectId}/restore`, {}),
    {
      invalidate: () => [qk.projects(), ['trash']],
      onSuccess: (result) => {
        push('项目已从回收站恢复', 'success', result.restoredTo);
        navigate(projectPath(result.project.projectId));
      },
      onError: (error) => push('恢复失败', 'error', error instanceof Error ? error.message : String(error)),
    },
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [openPath, setOpenPath] = useState('');
  const [form, setForm] = useState({ path: '', name: '' });
  const [pathTouched, setPathTouched] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [importForm, setImportForm] = useState({ source: '', destination: '' });
  const [restoreForm, setRestoreForm] = useState({ backup: '', destination: '' });
  const defaultRoot = appConfig.data?.defaultProjectRoot ?? projects.data?.root ?? capabilities.data?.workspace ?? '';

  const importProject = useApiMutation<ProjectSummary, { source: string; destination: string }>(
    (client, value) => client.post<ProjectSummary>('/v1/projects/import', value),
    {
      invalidate: () => [qk.projects()],
      onSuccess: (project) => {
        setImportOpen(false);
        setImportForm({ source: '', destination: '' });
        push('项目已导入', 'success', project.root);
        navigate(projectPath(project.projectId));
      },
      onError: (error) => push('导入失败', 'error', error instanceof Error ? error.message : String(error)),
    },
  );

  const restoreBackup = useApiMutation<ProjectSummary, { backup: string; destination: string }>(
    (client, value) => client.post<ProjectSummary>('/v1/projects/restore-backup', value),
    {
      invalidate: () => [qk.projects()],
      onSuccess: (project) => {
        setRestoreOpen(false);
        setRestoreForm({ backup: '', destination: '' });
        push('备份已恢复', 'success', project.root);
        navigate(projectPath(project.projectId));
      },
      onError: (error) => push('恢复失败', 'error', error instanceof Error ? error.message : String(error)),
    },
  );

  async function pickInto(target: 'import-source' | 'import-destination' | 'restore-backup' | 'restore-destination') {
    const picked = await pickDirectory();
    if (!picked) return;
    if (target === 'import-source') {
      setImportForm((current) => ({
        source: picked,
        destination: current.destination || (defaultRoot ? joinPath(defaultRoot, baseName(picked)) : ''),
      }));
    } else if (target === 'import-destination') {
      setImportForm((current) => ({ ...current, destination: joinPath(picked, baseName(current.source) || 'imported-project') }));
    } else if (target === 'restore-backup') {
      setRestoreForm((current) => ({
        backup: picked,
        destination: current.destination || (defaultRoot ? joinPath(defaultRoot, baseName(picked)) : ''),
      }));
    } else {
      setRestoreForm((current) => ({ ...current, destination: joinPath(picked, baseName(current.backup) || 'restored-project') }));
    }
  }

  const createProject = useApiMutation(
    (client, value: { path: string; name: string }) => client.post<ProjectSummary>('/v1/projects', value),
    {
      invalidate: () => [qk.projects()],
      onSuccess: (project) => {
        setCreateOpen(false);
        setForm({ path: '', name: '' });
        void queryClient.invalidateQueries({ queryKey: qk.projects() });
        push(project.created ? '项目已创建' : '项目已存在，已打开', 'success');
        navigate(projectPath(project.projectId));
      },
    },
  );

  const openProject = useApiMutation((client, path: string) => client.post<ProjectSummary>('/v1/projects/open', { path }), {
    invalidate: () => [qk.projects()],
    onSuccess: (project) => {
      setOpenPath('');
      push('项目已打开', 'success');
      navigate(projectPath(project.projectId));
    },
  });

  const totals = useMemo(() => {
    return (projects.data?.projects ?? []).reduce(
      (acc, project) => ({
        prompts: acc.prompts + (project.counts?.prompts ?? 0),
        cases: acc.cases + (project.counts?.cases ?? 0),
        runs: acc.runs + (project.counts?.runs ?? 0),
        reports: acc.reports + (project.counts?.reports ?? 0),
      }),
      { prompts: 0, cases: 0, runs: 0, reports: 0 },
    );
  }, [projects.data]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>工作区</h1>
          <div className="sub">
            本地项目目录：<span className="mono">{projects.data?.root ?? capabilities.data?.workspace ?? '…'}</span>
          </div>
        </div>
        <span className="spacer" />
        <div className="sticky-actions">
          <Button onClick={() => projects.refetch()} loading={projects.isFetching}>
            重新扫描
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setPathTouched(false);
              setForm({ path: defaultRoot ? joinPath(defaultRoot, '新项目') : '', name: '' });
              setCreateOpen(true);
            }}
          >
            新建项目
          </Button>
        </div>
      </header>

      {appConfig.data && !appConfig.data.onboarding.completedAt && appConfig.data.onboarding.skipped ? (
        <div className="notice" role="status">
          <div style={{ flex: 1 }}>
            <strong>初始设置尚未完成</strong>
            <div className="small dim">你可以随时完成目录、首个项目与模型配置。</div>
          </div>
          <Button size="small" onClick={() => navigate('/onboarding')}>
            完成初始设置
          </Button>
        </div>
      ) : null}

      <div className="grid cols-4">
        <Stat label="项目" value={projects.data?.projects.length ?? '—'} hint="工作区扫描 + 最近打开" />
        <Stat label="提示词版本" value={totals.prompts} hint="可追溯的不可变版本" />
        <Stat label="用例" value={totals.cases} hint="跨项目合计" />
        <Stat label="运行" value={totals.runs} hint={`报告 ${totals.reports} 份`} />
      </div>

      <Card
        title="打开已有项目"
        subtitle="输入项目根目录的绝对路径；也可直接把项目放在工作区下自动发现"
      >
        <div className="row">
          <Input
            className="mono"
            placeholder="/Users/me/projects/my-experiment"
            value={openPath}
            onChange={(event) => setOpenPath(event.target.value)}
            style={{ flex: '1 1 240px', minWidth: 0 }}
          />
          <Button
            onClick={() => openPath.trim() && openProject.mutate(openPath.trim())}
            loading={openProject.isPending}
            disabled={!openPath.trim()}
          >
            打开
          </Button>
        </div>
        {openProject.error ? <div style={{ marginTop: 10 }}><ErrorNotice error={openProject.error} /></div> : null}
      </Card>

      <Card
        title="导入与恢复"
        subtitle="导入已有的 PromptLens 项目目录，或从备份目录恢复到新位置；目标目录不能已存在项目"
      >
        <div className="row" style={{ gap: 8 }}>
          <Button onClick={() => { setImportForm({ source: '', destination: '' }); setImportOpen(true); }}>
            导入项目
          </Button>
          <Button onClick={() => { setRestoreForm({ backup: '', destination: '' }); setRestoreOpen(true); }}>
            从备份恢复
          </Button>
        </div>
      </Card>

      {projects.isError ? <ErrorNotice error={projects.error} onRetry={() => projects.refetch()} /> : null}

      {projects.isLoading ? (
        <Card>
          <div className="row" style={{ justifyContent: 'center', padding: 24 }}>
            <span className="spinner" /> 正在扫描项目…
          </div>
        </Card>
      ) : projects.data && projects.data.projects.length === 0 ? (
        <Card>
          <EmptyState
            title="工作区还没有项目"
            description="创建一个项目目录，PromptLens 会把数据库、对象与报告写入其中，便于版本管理。"
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                新建第一个项目
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid cols-3">
          {projects.data?.projects.map((project) => (
            <ProjectCard key={project.projectId} project={project} />
          ))}
        </div>
      )}

      {trash.data?.entries.length ? (
        <Card title="回收站" subtitle="删除的项目默认移入应用数据目录的 trash/，确认无用后可手动清理">
          <div className="stack">
            {trash.data.entries.map((entry) => (
              <div className="row" key={entry.projectId}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="truncate">{entry.name}</div>
                  <div className="small dim mono truncate" title={entry.originalPath}>
                    {entry.originalPath} · {formatDateTime(entry.trashedAt)}
                  </div>
                </div>
                <Button size="small" loading={restore.isPending} onClick={() => restore.mutate(entry.projectId)}>
                  恢复到原路径
                </Button>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card title="本地运行环境" subtitle="UI 仅通过环回 HTTP 访问核心；令牌只保存在内存">
        <div className="grid cols-3">
          <div>
            <div className="label small dim">服务版本</div>
            <div className="mono">{capabilities.data ? `${capabilities.data.product} ${capabilities.data.serverVersion}` : '—'}</div>
          </div>
          <div>
            <div className="label small dim">API 版本</div>
            <div className="mono">{capabilities.data?.apiVersion ?? '—'}</div>
          </div>
          <div>
            <div className="label small dim">事件流</div>
            <div>{capabilities.data?.features.sse ? <Badge tone="ok">SSE 可用</Badge> : <Badge>—</Badge>}</div>
          </div>
        </div>
      </Card>

      <Modal
        open={createOpen}
        title="新建项目"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              loading={createProject.isPending}
              disabled={!form.path.trim() || !form.name.trim()}
              onClick={() => createProject.mutate({ path: form.path.trim(), name: form.name.trim() })}
            >
              创建并打开
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="项目名称">
            <Input
              value={form.name}
              onChange={(event) => {
                const name = event.target.value;
                setForm((current) => ({
                  name,
                  path: !pathTouched && defaultRoot ? joinPath(defaultRoot, safeName(name)) : current.path,
                }));
              }}
              placeholder="客服回复质量实验"
            />
          </Field>
          <Field label="项目目录（绝对路径）" hint={defaultRoot ? `默认目录：${defaultRoot}；目录不存在会自动创建。` : '目录不存在会自动创建；已存在项目则直接打开。'}>
            <Input
              className="mono"
              value={form.path}
              onChange={(event) => {
                setPathTouched(true);
                setForm({ ...form, path: event.target.value });
              }}
              placeholder="/Users/me/prompt-experiments"
            />
          </Field>
          {createProject.error ? <ErrorNotice error={createProject.error} /> : null}
        </div>
      </Modal>

      <Modal
        open={importOpen}
        title="导入项目"
        onClose={() => setImportOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>取消</Button>
            <Button
              variant="primary"
              loading={importProject.isPending}
              disabled={!importForm.source.trim() || !importForm.destination.trim()}
              onClick={() => importProject.mutate({ source: importForm.source.trim(), destination: importForm.destination.trim() })}
            >
              导入
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="来源项目目录" hint="目录中需包含 promptlens.project.yaml 与 .promptlens/db/project.sqlite3">
            <div className="row" style={{ gap: 8 }}>
              <Input
                className="mono"
                value={importForm.source}
                onChange={(event) => setImportForm({ ...importForm, source: event.target.value })}
                placeholder="/Users/me/old-project"
                style={{ flex: 1, minWidth: 0 }}
              />
              <Button onClick={() => pickInto('import-source')}>选择</Button>
            </div>
          </Field>
          <Field label="目标目录（绝对路径）" hint="目标不能是已存在的 PromptLens 项目，以免覆盖。">
            <div className="row" style={{ gap: 8 }}>
              <Input
                className="mono"
                value={importForm.destination}
                onChange={(event) => setImportForm({ ...importForm, destination: event.target.value })}
                placeholder="/Users/me/projects/imported-project"
                style={{ flex: 1, minWidth: 0 }}
              />
              <Button onClick={() => pickInto('import-destination')}>选择</Button>
            </div>
          </Field>
          {importProject.error ? <ErrorNotice error={importProject.error} /> : null}
        </div>
      </Modal>

      <Modal
        open={restoreOpen}
        title="从备份恢复"
        onClose={() => setRestoreOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRestoreOpen(false)}>取消</Button>
            <Button
              variant="primary"
              loading={restoreBackup.isPending}
              disabled={!restoreForm.backup.trim() || !restoreForm.destination.trim()}
              onClick={() => restoreBackup.mutate({ backup: restoreForm.backup.trim(), destination: restoreForm.destination.trim() })}
            >
              恢复
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="备份目录" hint="需包含 promptlens.backup.json 元数据文件">
            <div className="row" style={{ gap: 8 }}>
              <Input
                className="mono"
                value={restoreForm.backup}
                onChange={(event) => setRestoreForm({ ...restoreForm, backup: event.target.value })}
                placeholder="/Users/me/Library/.../backups/my-project-20261126"
                style={{ flex: 1, minWidth: 0 }}
              />
              <Button onClick={() => pickInto('restore-backup')}>选择</Button>
            </div>
          </Field>
          <Field label="目标目录（绝对路径）" hint="恢复会复制备份内容到新目录，不会修改备份本身。">
            <div className="row" style={{ gap: 8 }}>
              <Input
                className="mono"
                value={restoreForm.destination}
                onChange={(event) => setRestoreForm({ ...restoreForm, destination: event.target.value })}
                placeholder="/Users/me/projects/restored-project"
                style={{ flex: 1, minWidth: 0 }}
              />
              <Button onClick={() => pickInto('restore-destination')}>选择</Button>
            </div>
          </Field>
          {restoreBackup.error ? <ErrorNotice error={restoreBackup.error} /> : null}
        </div>
      </Modal>
    </div>
  );
}

function baseName(path: string) {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || '';
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const counts = project.counts ?? { prompts: 0, cases: 0, runs: 0, reports: 0 };
  return (
    <button
      type="button"
      className="card"
      style={{ textAlign: 'left', padding: 16, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 10 }}
      onClick={() => navigate(projectPath(project.projectId))}
    >
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 650, fontSize: 14.5 }} className="truncate">
            {project.name}
          </div>
          <div className="small dim mono truncate" title={project.root}>
            {project.root}
          </div>
        </div>
        {project.source === 'recent' ? <Badge tone="info">最近</Badge> : null}
        {project.archivedAt ? <Badge tone="warn">已归档</Badge> : null}
      </div>
      <div className="row small dim" style={{ gap: 14 }}>
        <span>提示词 {counts.prompts}</span>
        <span>用例 {counts.cases}</span>
        <span>运行 {counts.runs}</span>
        <span>报告 {counts.reports}</span>
      </div>
      <div className="small dim">最近打开：{project.lastOpenedAt ? formatDateTime(project.lastOpenedAt) : '—'}</div>
    </button>
  );
}
