import { useState } from 'react';
import type { ProjectOverview, ProjectRecoveryResult, ProjectSettings } from '@promptlens/contracts';
import { qk, useApiMutation, useApiQuery } from '../../api/hooks';
import { Badge, Button, Card, CopyButton, EmptyState, ErrorNotice, Field, HealthDot, Input, Modal, Stat, formatDateTime, useToast } from '../../components/ui';
import { navigate, projectPath } from '../../app/router';
import { RunTable } from '../runs/RunTable';

export function ProjectHomePage({ projectId }: { projectId: string }) {
  const toast = useToast();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [permanent, setPermanent] = useState(false);
  const [confirmId, setConfirmId] = useState('');
  const overview = useApiQuery<ProjectOverview>(qk.overview(projectId), (client) => client.get(`/v1/projects/${projectId}/overview`), {
    refetchInterval: 10_000,
  });
  const settings = useApiQuery<{ projectId: string; settings: ProjectSettings }>(
    ['project-settings', projectId],
    (client) => client.get(`/v1/projects/${projectId}/settings`),
    { enabled: Boolean(projectId) },
  );
  const invalidateProject = () => [qk.overview(projectId), qk.project(projectId), qk.projects()];

  const rename = useApiMutation<unknown, string>((client, name) => client.post(`/v1/projects/${projectId}/rename`, { name }), {
    invalidate: invalidateProject,
    onSuccess: () => {
      setRenameOpen(false);
      toast.push('项目已重命名', 'success');
    },
    onError: (error) => toast.push('重命名失败', 'error', error instanceof Error ? error.message : String(error)),
  });
  const archive = useApiMutation<unknown, boolean>((client, archived) => client.post(`/v1/projects/${projectId}/archive`, { archived }), {
    invalidate: invalidateProject,
    onSuccess: (_data, archived) => toast.push(archived ? '项目已归档，数据保留' : '项目已取消归档', 'success'),
  });
  const backup = useApiMutation<{ path: string; files: number; bytes: number }, void>((client) => client.post(`/v1/projects/${projectId}/backup`, {}), {
    onSuccess: (data) => toast.push('备份完成', 'success', `${data.path}（${data.files} 个文件）`),
    onError: (error) => toast.push('备份失败', 'error', error instanceof Error ? error.message : String(error)),
  });
  const recovery = useApiQuery<{ copies: ProjectRecoveryResult[] }>(['recovery'], (client) => client.get('/v1/recovery'), {
    refetchInterval: 30_000,
  });
  const projectRecoveries = (recovery.data?.copies ?? []).filter((copy) => copy.projectId === projectId);
  const createRecovery = useApiMutation<ProjectRecoveryResult, void>((client) => client.post(`/v1/projects/${projectId}/recovery`, {}), {
    invalidate: () => [['recovery']],
    onSuccess: (data) => toast.push('恢复副本已生成', 'success', data.path),
    onError: (error) => toast.push('生成恢复副本失败', 'error', error instanceof Error ? error.message : String(error)),
  });
  const remove = useApiMutation<
    { permanent: boolean; path: string },
    { permanent: boolean; confirmProjectId?: string }
  >((client, body) => client.post(`/v1/projects/${projectId}/delete`, body), {
    invalidate: () => [qk.projects()],
    onSuccess: (data) => {
      setDeleteOpen(false);
      toast.push(data.permanent ? '项目已永久删除' : '项目已移入回收站', 'success', data.path);
      navigate('/');
    },
    onError: (error) => toast.push('删除失败', 'error', error instanceof Error ? error.message : String(error)),
  });
  const updateSettings = useApiMutation<unknown, Partial<ProjectSettings>>(
    (client, patch) => client.patch(`/v1/projects/${projectId}/settings`, patch),
    { invalidate: () => [['project-settings', projectId]] },
  );

  if (overview.isError) {
    return (
      <div className="page">
        <ErrorNotice error={overview.error} onRetry={() => overview.refetch()} />
      </div>
    );
  }
  if (!overview.data) {
    return (
      <div className="page">
        <div className="row" style={{ justifyContent: 'center', padding: 40 }}>
          <span className="spinner" /> 加载项目…
        </div>
      </div>
    );
  }

  const { summary, health, recentRuns, recentReports, analytics, lastRunAt } = overview.data;
  const problems = health.checks.filter((check) => check.status !== 'ok');

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>
            {summary.name}
            {summary.archivedAt ? <Badge tone="warn" > 已归档</Badge> : null}
          </h1>
          <div className="sub mono">{summary.root}</div>
        </div>
        <span className="spacer" />
        <div className="sticky-actions">
          <Button onClick={() => navigate(projectPath(projectId, '/prompts'))}>编辑提示词</Button>
          <Button onClick={() => navigate(projectPath(projectId, '/cases'))}>管理用例</Button>
          <Button variant="primary" onClick={() => navigate(projectPath(projectId, '/experiments/new'))}>
            新建实验
          </Button>
        </div>
      </header>

      {problems.length ? (
        <div className="notice warn">
          <div>
            <strong>项目健康检查有 {problems.length} 项异常</strong>
            <div className="small">
              {problems
                .map((check) => `${check.name}: ${String(check.status)}`)
                .slice(0, 4)
                .join(' · ')}
            </div>
          </div>
        </div>
      ) : (
        <div className="notice info">
          <HealthDot status={health.status} />
          <span>
            项目健康：{health.status === 'ok' ? '正常' : health.status} · 数据库完整性 {String(health.checks.find((item) => item.name === 'database_integrity')?.status ?? '—')} · 最近运行{' '}
            {lastRunAt ? formatDateTime(lastRunAt) : '从未运行'}
          </span>
        </div>
      )}

      <div className="grid cols-4">
        <Stat label="提示词版本" value={summary.counts.promptVersions} hint={`${summary.counts.prompts} 个提示词`} />
        <Stat label="用例" value={summary.counts.cases} hint={`${summary.counts.testSets} 个测试集`} />
        <Stat label="运行" value={summary.counts.runs} hint={`完成 ${analytics.completed} · 有错误 ${analytics.withErrors}`} />
        <Stat label="报告" value={summary.counts.reports} hint="按运行归档，不可变" />
      </div>

      <div className="split-view dashboard">
        <Card
          title="最近运行"
          subtitle={`共 ${overview.data.runTotal} 次运行`}
          flush
          actions={<Button size="small" onClick={() => navigate(projectPath(projectId, '/runs'))}>全部运行</Button>}
        >
          {recentRuns.length ? <RunTable projectId={projectId} runs={recentRuns} maxHeight={330} /> : <EmptyState title="还没有运行" description="在向导中冻结快照并启动第一个实验。" />}
        </Card>

        <div className="stack">
          <Card title="快捷动作">
            <div className="stack" style={{ gap: 8 }}>
              <Button block onClick={() => navigate(projectPath(projectId, '/experiments/new'))}>
                新建实验
              </Button>
              <Button block onClick={() => navigate(projectPath(projectId, '/prompts'))}>
                提示词实验室
              </Button>
              <Button block onClick={() => navigate(projectPath(projectId, '/cases'))}>
                用例库
              </Button>
              <Button block onClick={() => navigate('/models')}>
                模型中心
              </Button>
            </div>
          </Card>

          <Card title="项目维护" subtitle="备份只包含清单、数据库、对象与导出，不包括无关源码">
            <div className="row" style={{ gap: 8 }}>
              <Button size="small" onClick={() => { setRenameValue(summary.name); setRenameOpen(true); }}>重命名</Button>
              <Button size="small" loading={backup.isPending} onClick={() => backup.mutate()}>备份</Button>
              <Button size="small" loading={createRecovery.isPending} onClick={() => createRecovery.mutate()}>生成恢复副本</Button>
              <Button size="small" onClick={() => archive.mutate(!summary.archivedAt)}>
                {summary.archivedAt ? '取消归档' : '归档'}
              </Button>
              <Button size="small" variant="danger" onClick={() => { setPermanent(false); setConfirmId(''); setDeleteOpen(true); }}>删除</Button>
            </div>
            <div className="stack" style={{ gap: 8, marginTop: 12 }}>
              <label className="row small" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={settings.data?.settings.autoReport ?? true}
                  onChange={(event) => updateSettings.mutate({ autoReport: event.target.checked })}
                />
                运行结束后自动生成报告版本
              </label>
              <label className="row small" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={settings.data?.settings.autoExport ?? true}
                  onChange={(event) => updateSettings.mutate({ autoExport: event.target.checked })}
                />
                同时写入 exports/reports（关闭后仅保留可预览版本）
              </label>
            </div>
            <div className="stack" style={{ gap: 6, marginTop: 12 }}>
              <div className="label small dim">恢复副本（只读快照，位于应用数据目录 recovery/）</div>
              {projectRecoveries.length ? (
                projectRecoveries.map((copy) => (
                  <div className="row small" key={copy.path} style={{ gap: 8 }}>
                    <span className="mono truncate" style={{ flex: 1, minWidth: 0 }} title={copy.path}>
                      {copy.path}
                    </span>
                    <span className="dim">{formatDateTime(copy.recoveryAt)}</span>
                    <Badge tone={copy.databaseStatus === 'readable' ? 'ok' : 'warn'}>{copy.databaseStatus}</Badge>
                    <CopyButton value={copy.path} small />
                  </div>
                ))
              ) : (
                <div className="small dim">还没有恢复副本。</div>
              )}
            </div>
          </Card>

          <Card title="最近报告" flush>
            {recentReports.length ? (
              <div className="list" style={{ padding: 8 }}>
                {recentReports.map((report) => (
                  <button key={report.reportId} className="list-item" onClick={() => navigate(projectPath(projectId, '/reports'))}>
                    <span className="mono small">{report.reportId.slice(0, 10)}</span>
                    <span className="small dim">{formatDateTime(report.generatedAt)}</span>
                    <span className="spacer" />
                    <Badge tone="ok">v{report.templateVersionId.replace(/\D/g, '') || '1'}</Badge>
                  </button>
                ))}
              </div>
            ) : (
              <div className="table-empty">运行结束后可生成报告</div>
            )}
          </Card>

          <Card title="健康明细">
            <div className="stack" style={{ gap: 6 }}>
              {health.checks.map((check) => (
                <div key={check.name} className="row small">
                  <HealthDot status={check.status} />
                  <span className="mono">{check.name}</span>
                  <span className="spacer" />
                  <span className="dim">{String(check.status)}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Modal
        open={renameOpen}
        title="重命名项目"
        onClose={() => setRenameOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>取消</Button>
            <Button variant="primary" disabled={!renameValue.trim() || rename.isPending} loading={rename.isPending} onClick={() => rename.mutate(renameValue.trim())}>
              保存
            </Button>
          </>
        }
      >
        <Field label="项目名称" hint="只修改展示名称，项目 ID 与目录保持不变">
          <Input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus />
        </Field>
      </Modal>

      <Modal
        open={deleteOpen}
        title="删除项目"
        onClose={() => setDeleteOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>取消</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              disabled={permanent && confirmId !== projectId}
              onClick={() => remove.mutate({ permanent, confirmProjectId: permanent ? confirmId : undefined })}
            >
              {permanent ? '永久删除' : '移入回收站'}
            </Button>
          </>
        }
      >
        <div className="stack">
          <div className="notice warn">
            <span>删除只移除项目目录；备份与导出文件不会被清理。默认移入应用数据目录的 trash/，可恢复。</span>
          </div>
          <label className="row small" style={{ gap: 8 }}>
            <input type="checkbox" checked={permanent} onChange={(event) => setPermanent(event.target.checked)} />
            永久删除（不可恢复）
          </label>
          {permanent ? (
            <Field label="确认项目 ID" hint={`请输入 ${projectId} 以确认永久删除`}>
              <Input value={confirmId} onChange={(event) => setConfirmId(event.target.value.trim())} className="mono" />
            </Field>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
