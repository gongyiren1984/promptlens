import { useEffect, useState } from 'react';
import type { AppConfig, AuditEvent, Capabilities, McpProjectInfo, ProjectHealth, ProjectSettings } from '@promptlens/contracts';
import { qk, useApiMutation, useApiQuery } from '../../api/hooks';
import { pickDirectory } from '../../api/bridge';
import { Link, navigate, projectPath } from '../../app/router';
import { Badge, Button, Card, CopyButton, ErrorNotice, Field, HealthDot, Input, Tabs, Textarea, Toggle, formatDateTime, useToast } from '../../components/ui';
import { DataTable } from '../../components/table';
import { useThemePreference, type ThemePreference } from '../../app/theme';

export function SettingsPage({ projectId: routeProjectId }: { projectId: string | null }) {
  const { push } = useToast();
  const [tab, setTab] = useState<'runtime' | 'maintenance' | 'errors'>('runtime');
  const [theme, setTheme] = useThemePreference();
  const projectId = routeProjectId ?? localStorage.getItem('promptlens.lastProjectId');
  const capabilities = useApiQuery<Capabilities>(qk.capabilities(), (client) => client.get('/v1/capabilities'), { staleTime: 30_000 });
  const health = useApiQuery<ProjectHealth>(
    qk.health(projectId ?? 'none'),
    (client) => client.get(`/v1/projects/${projectId}/health`),
    { enabled: Boolean(projectId) },
  );
  const audit = useApiQuery<{ total: number; events: AuditEvent[] }>(
    qk.audit(projectId ?? 'none'),
    (client) => client.get(`/v1/projects/${projectId}/audit`, { query: { limit: 100 } }),
    { enabled: Boolean(projectId) },
  );
  const settings = useApiQuery<{ projectId: string; settings: ProjectSettings }>(
    qk.settings(projectId ?? 'none'),
    (client) => client.get(`/v1/projects/${projectId}/settings`),
    { enabled: Boolean(projectId) },
  );
  const saveSettings = useApiMutation(
    (client, value: Partial<ProjectSettings>) =>
      client.patch<{ projectId: string; settings: ProjectSettings }>(`/v1/projects/${projectId}/settings`, value),
    {
      invalidate: () => (projectId ? [qk.settings(projectId)] : []),
      onSuccess: () => push('项目设置已保存', 'success'),
      onError: (error) => push((error as Error).message, 'error'),
    },
  );
  const [autoReport, setAutoReport] = useState(true);
  const [autoExport, setAutoExport] = useState(true);
  const [sensitiveText, setSensitiveText] = useState('');
  useEffect(() => {
    if (!settings.data) return;
    setAutoReport(settings.data.settings.autoReport);
    setAutoExport(settings.data.settings.autoExport);
    setSensitiveText((settings.data.settings.sensitiveFields ?? []).join('\n'));
  }, [settings.data]);
  const replayTour = useApiMutation(
    (client) => client.patch<AppConfig>('/v1/app/config', { tour: { completedVersion: null } }),
    {
      invalidate: () => [qk.appConfig()],
      onSuccess: () => navigate('/'),
      onError: (error) => push((error as Error).message, 'error'),
    },
  );
  const [errorFilter, setErrorFilter] = useState('');
  const [mcpWrite, setMcpWrite] = useState(false);
  const [workspaceInput, setWorkspaceInput] = useState('');
  const switchWorkspace = useApiMutation(
    (client, value: string) => client.patch<AppConfig>('/v1/app/config', { workspaceRoot: value }),
    {
      invalidate: () => [qk.appConfig(), qk.capabilities(), qk.projects()],
      onSuccess: () => push('工作区已切换，重启后仍然生效', 'success'),
      onError: (error) => push((error as Error).message, 'error'),
    },
  );
  const mcpScopes = mcpWrite ? 'project:read,run:read,run:write,project:write' : 'project:read,run:read';
  const mcpInfo = useApiQuery<McpProjectInfo>(
    qk.mcpInfo(projectId ?? 'none', mcpScopes),
    (client) => client.get(`/v1/projects/${projectId}/mcp-info`, { query: { scopes: mcpScopes } }),
    { enabled: Boolean(projectId) },
  );

  useEffect(() => {
    if (capabilities.data?.workspace) setWorkspaceInput(capabilities.data.workspace);
  }, [capabilities.data?.workspace]);

  const errorCodes = (capabilities.data?.errorCodes ?? []).filter(
    (entry) =>
      !errorFilter ||
      entry.code.toLowerCase().includes(errorFilter.toLowerCase()) ||
      entry.message.includes(errorFilter),
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>设置</h1>
          <div className="sub">默认预算、数据维护与集成信息；密钥以 env: 或 keychain: 引用保存。</div>
        </div>
        <span className="spacer" />
        {projectId ? <Button onClick={() => navigate(projectPath(projectId))}>回到项目</Button> : null}
      </header>

      <Tabs
        tabs={[
          { id: 'runtime', label: '本地运行环境' },
          { id: 'maintenance', label: '项目维护' },
          { id: 'errors', label: '错误码目录' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {capabilities.isError ? <ErrorNotice error={capabilities.error} onRetry={() => capabilities.refetch()} /> : null}

      {tab === 'runtime' && capabilities.data ? (
        <div className="stack">
          <Card title="外观" subtitle="跟随系统时，系统深浅色切换会在 1 秒内生效，不丢失当前表单">
            <div className="row">
              {THEME_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  variant={theme === option.value ? 'primary' : 'ghost'}
                  onClick={() => setTheme(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </Card>
          <Card title="核心服务" subtitle="UI 只通过环回 HTTP 访问核心，不直接接触数据库与对象存储">
            <dl className="kv">
              <dt>产品</dt>
              <dd>{capabilities.data.product}</dd>
              <dt>服务版本</dt>
              <dd className="mono">{capabilities.data.serverVersion}</dd>
              <dt>API 版本</dt>
              <dd className="mono">{capabilities.data.apiVersion}</dd>
              <dt>工作区</dt>
              <dd className="mono">{capabilities.data.workspace}</dd>
              <dt>环回地址</dt>
              <dd className="mono">{capabilities.data.transport.host}:{capabilities.data.transport.port}</dd>
              <dt>MCP 协议</dt>
              <dd className="mono">
                {capabilities.data.mcp.defaultProtocolVersion}（支持 {capabilities.data.mcp.supportedProtocolVersions.join(', ')}）
              </dd>
              <dt>报告章节</dt>
              <dd>{capabilities.data.report.requiredSections.join(' / ')}</dd>
            </dl>
            <div className="row" style={{ marginTop: 10 }}>
              <CopyButton value={capabilities.data.workspace} label="复制工作区路径" small />
            </div>
          </Card>

          <Card
            title="MCP 接入"
            subtitle="本应用同时作为 MCP Server 运行，通过 stdio 向外部 AI 客户端暴露工具"
            actions={
              mcpInfo.data ? (
                <CopyButton value={JSON.stringify(mcpInfo.data.clientConfig, null, 2)} label="复制客户端配置" small />
              ) : null
            }
          >
            {!projectId ? (
              <div className="small dim">请先打开一个项目，再查看该项目的 MCP 启动命令与客户端配置。</div>
            ) : mcpInfo.isError ? (
              <ErrorNotice error={mcpInfo.error} onRetry={() => mcpInfo.refetch()} />
            ) : mcpInfo.data ? (
              <div className="stack">
                <dl className="kv">
                  <dt>传输方式</dt>
                  <dd className="mono">{mcpInfo.data.transports.join(', ')}</dd>
                  <dt>协议版本</dt>
                  <dd className="mono">
                    {mcpInfo.data.defaultProtocolVersion}（支持 {mcpInfo.data.supportedProtocolVersions.join(', ')}）
                  </dd>
                  <dt>工具数量</dt>
                  <dd className="mono">{mcpInfo.data.toolCount}</dd>
                  <dt>项目根目录</dt>
                  <dd className="mono">{mcpInfo.data.projectRoot}</dd>
                </dl>
                <Toggle
                  checked={mcpWrite}
                  onChange={setMcpWrite}
                  label="授予写入权限"
                  hint="包含 run:write 与 project:write；默认仅只读"
                />
                <Field label="启动命令" hint="将以下配置粘贴到支持 MCP 的客户端（如 Claude Desktop、Cursor）的 mcpServers 中">
                  <pre className="mono small" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
{JSON.stringify(mcpInfo.data.clientConfig, null, 2)}
                  </pre>
                </Field>
                <div className="row wrap">
                  <CopyButton
                    value={`${mcpInfo.data.launch.command} ${mcpInfo.data.launch.args.join(' ')}`}
                    label="复制启动命令"
                    small
                  />
                  <span className="small dim">工具：{mcpInfo.data.tools.join(', ')}</span>
                </div>
              </div>
            ) : (
              <div className="small dim">正在读取 MCP 信息…</div>
            )}
          </Card>

          <Card title="上限" flush>
            <DataTable
              columns={[
                { key: 'name', header: '限制项', render: (row: { name: string; value: number }) => <span className="mono small">{row.name}</span> },
                { key: 'value', header: '值', align: 'right', render: (row: { name: string; value: number }) => <span className="mono">{row.value}</span> },
              ]}
              rows={Object.entries(capabilities.data.limits).map(([name, value]) => ({ name, value }))}
              rowKey={(row) => row.name}
              maxHeight={320}
            />
          </Card>

          <Card title="安全边界">
            <ul className="small" style={{ margin: 0, paddingLeft: 18, color: 'var(--text-dim)' }}>
              <li>仅绑定 127.0.0.1 随机端口，所有请求需一次性 Bearer 令牌。</li>
              <li>令牌由桌面壳通过 core_endpoint 命令下发，只保存在内存，不进入 localStorage、报告或日志。</li>
              <li>Origin 与 Host 白名单校验；WebView 不启用任意文件系统与 shell 权限。</li>
              <li>模型凭据只允许 env: 或 keychain: 引用，明文不写入项目数据库。</li>
              <li>报告与审计保留边界：审计事件只读，报告版本不可变，删除草稿不影响历史运行。</li>
            </ul>
          </Card>

          <Card
            title="全局工作区"
            subtitle="工作区决定新建项目与项目扫描的默认位置；切换立即生效，并在下次启动时沿用"
            actions={
              <Button
                size="small"
                variant="primary"
                loading={switchWorkspace.isPending}
                disabled={!workspaceInput.trim()}
                onClick={() => switchWorkspace.mutate(workspaceInput.trim())}
              >
                切换工作区
              </Button>
            }
          >
            <div className="stack">
              <Field label="工作区路径" hint="必须是绝对路径；目录不存在时会自动创建">
                <div className="row">
                  <Input value={workspaceInput} onChange={(event) => setWorkspaceInput(event.target.value)} placeholder="/Users/you/PromptLens" />
                  <Button
                    size="small"
                    disabled={!window.__TAURI_INTERNALS__}
                    onClick={async () => {
                      try {
                        const picked = await pickDirectory();
                        if (picked) setWorkspaceInput(picked);
                        else push('未选择目录，可直接输入绝对路径', 'warn');
                      } catch (error) {
                        push(`无法打开系统目录选择器：${(error as Error).message}`, 'error');
                      }
                    }}
                  >
                    选择目录
                  </Button>
                </div>
                {window.__TAURI_INTERNALS__ ? null : (
                  <div className="notice warn small" style={{ marginTop: 6 }}>
                    浏览器预览模式不支持系统目录选择，请直接输入绝对路径。
                  </div>
                )}
              </Field>
              <div className="small dim">
                当前生效：<span className="mono">{capabilities.data?.workspace ?? '—'}</span>
              </div>
              {switchWorkspace.error ? <ErrorNotice error={switchWorkspace.error} /> : null}
            </div>
          </Card>

          <Card title="引导与合规" subtitle="重新运行设置向导，或查看数据处理说明与第三方许可">
            <div className="row wrap">
              <Button size="small" onClick={() => navigate('/onboarding')}>
                重新运行初始引导
              </Button>
              <Button size="small" loading={replayTour.isPending} onClick={() => replayTour.mutate()}>
                重新运行新手引导
              </Button>
              <Link className="btn" to="/about">
                关于
              </Link>
              <Link className="btn" to="/legal/privacy">
                数据处理与隐私
              </Link>
              <Link className="btn" to="/legal/terms">
                许可与用户协议
              </Link>
              <Link className="btn" to="/legal/notices">
                第三方许可
              </Link>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'maintenance' ? (
        projectId ? (
          <div className="stack">
            <Card
              title="项目设置"
              subtitle="关闭自动报告可避免运行结束后自动生成；敏感字段会在新报告生成时替换为 [REDACTED]"
              actions={
                <Button
                  size="small"
                  variant="primary"
                  loading={saveSettings.isPending}
                  onClick={() =>
                    saveSettings.mutate({
                      autoReport,
                      autoExport,
                      sensitiveFields: sensitiveText
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean),
                    })
                  }
                >
                  保存
                </Button>
              }
            >
              <div className="stack">
                <Toggle checked={autoReport} onChange={setAutoReport} label="运行结束后自动生成报告" hint="关闭后需手动生成报告版本" />
                <Toggle checked={autoExport} onChange={setAutoExport} label="自动报告导出到 exports 目录" />
                <Field label="敏感字段脱敏" hint="每行一条；支持字面量或 regex: 前缀的正则。保存后仅影响新生成的报告。">
                  <Textarea
                    value={sensitiveText}
                    onChange={(event) => setSensitiveText(event.target.value)}
                    rows={4}
                    placeholder={'例如：\n13800000000\nregex:\\b\\d{17}[\\dXx]\\b'}
                  />
                </Field>
                {settings.isError ? <ErrorNotice error={settings.error} onRetry={() => settings.refetch()} /> : null}
                {saveSettings.error ? <ErrorNotice error={saveSettings.error} /> : null}
              </div>
            </Card>

            <Card
              title="项目健康"
              subtitle={health.data ? `状态 ${health.data.status}` : undefined}
              actions={<Button size="small" onClick={() => health.refetch()} loading={health.isFetching}>重新检查</Button>}
              flush
            >
              {health.isError ? (
                <div style={{ padding: 14 }}>
                  <ErrorNotice error={health.error} onRetry={() => health.refetch()} />
                </div>
              ) : (
                <DataTable
                  columns={[
                    {
                      key: 'check',
                      header: '检查项',
                      render: (row: ProjectHealth['checks'][number]) => (
                        <span className="row" style={{ gap: 6 }}>
                          <HealthDot status={row.status} /> <span className="mono">{row.name}</span>
                        </span>
                      ),
                    },
                    { key: 'status', header: '状态', render: (row: ProjectHealth['checks'][number]) => <Badge tone={row.status === 'ok' ? 'ok' : row.status === 'degraded' ? 'warn' : 'error'}>{row.status}</Badge> },
                    {
                      key: 'details',
                      header: '详情',
                      render: (row: ProjectHealth['checks'][number]) => (
                        <span className="small dim mono">{JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'name' && key !== 'status')))}</span>
                      ),
                    },
                  ]}
                  rows={health.data?.checks ?? []}
                  rowKey={(row) => row.name}
                  maxHeight={280}
                />
              )}
            </Card>

            <Card title="数据维护建议">
              <ul className="small" style={{ margin: 0, paddingLeft: 18, color: 'var(--text-dim)' }}>
                <li>备份：停止运行后复制整个项目目录（包含 .promptlens 与 exports）。</li>
                <li>孤儿对象清理需在核对报告引用后手工执行；当前版本不提供自动删除，避免误删证据。</li>
                <li>数据库损坏：使用健康检查确认 integrity；必要时从备份恢复。</li>
                <li>写入锁冲突：确认没有其他 PromptLens 实例正在写同一项目。</li>
              </ul>
            </Card>

            <Card title={`审计事件（${audit.data?.total ?? 0}）`} flush>
              {audit.isError ? (
                <div style={{ padding: 14 }}>
                  <ErrorNotice error={audit.error} onRetry={() => audit.refetch()} />
                </div>
              ) : (
                <DataTable
                  columns={[
                    { key: 'time', header: '时间', render: (row: AuditEvent) => <span className="small">{formatDateTime(row.createdAt)}</span> },
                    { key: 'type', header: '类型', render: (row: AuditEvent) => <span className="mono small">{row.type}</span> },
                    { key: 'actor', header: '来源', render: (row: AuditEvent) => <span className="small dim">{row.actor}</span> },
                    { key: 'payload', header: '负载', render: (row: AuditEvent) => <span className="small dim mono truncate" style={{ maxWidth: 420, display: 'inline-block' }}>{row.payload ? JSON.stringify(row.payload) : '—'}</span> },
                  ]}
                  rows={audit.data?.events ?? []}
                  rowKey={(row) => row.id}
                  maxHeight={320}
                />
              )}
            </Card>
          </div>
        ) : (
          <Card>
            <div className="empty">
              <div className="title">未打开项目</div>
              <div>从工作区进入项目后可查看健康检查与审计事件。</div>
              <Button onClick={() => navigate('/')}>去工作区</Button>
            </div>
          </Card>
        )
      ) : null}

      {tab === 'errors' ? (
        <div className="stack">
          <div className="toolbar">
            <Input placeholder="搜索错误码或文案" value={errorFilter} onChange={(event) => setErrorFilter(event.target.value)} style={{ minWidth: 260 }} />
            <span className="small dim">{errorCodes.length} 条</span>
          </div>
          <Card flush>
            <DataTable
              columns={[
                { key: 'code', header: '错误码', render: (row: { code: string }) => <span className="mono">{row.code}</span> },
                { key: 'exit', header: '退出码', align: 'right', render: (row: { exitCode: number }) => <span className="mono">{row.exitCode}</span> },
                { key: 'retry', header: '可重试', render: (row: { retryable: boolean }) => (row.retryable ? <Badge tone="warn">是</Badge> : <Badge tone="muted">否</Badge>) },
                { key: 'scope', header: '范围', render: (row: { scope: string }) => <span className="small dim">{row.scope}</span> },
                { key: 'message', header: '含义', render: (row: { message: string }) => <span className="small">{row.message}</span> },
              ]}
              rows={errorCodes}
              rowKey={(row) => row.code}
              maxHeight={480}
            />
          </Card>
        </div>
      ) : null}
    </div>
  );
}

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];
