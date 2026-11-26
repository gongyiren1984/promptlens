import { useEffect, useState, type ReactNode } from 'react';
import { useApiQuery, qk } from '../api/hooks';
import { getClient, resetClient } from '../api/bridge';
import type { Capabilities, ProjectHealth, ProjectSummary } from '@promptlens/contracts';
import { Badge, Button, HealthDot } from './ui';
import { Link, projectPath, useRoute } from '../app/router';
import { useSystemLight, useThemePreference } from '../app/theme';

const PAGE_TITLES: Record<string, string> = {
  workspace: '工作区',
  project: '项目首页',
  prompts: '提示词实验室',
  cases: '用例库',
  wizard: '新建实验',
  runs: '运行历史',
  run: '运行监控',
  compare: '结果比较',
  analytics: '分析',
  reports: '报告',
  models: '模型中心',
  settings: '设置',
  onboarding: '初始设置',
  about: '关于',
  privacy: '数据处理与隐私',
  terms: '用户协议',
  notices: '第三方许可',
  'not-found': '页面不存在',
};

export function AppShell({ children }: { children: ReactNode }) {
  const route = useRoute();
  const projectId = route.params.projectId ?? null;
  const [theme, setTheme] = useThemePreference();
  const systemLight = useSystemLight();
  const resolvedTheme = theme === 'system' ? (systemLight ? 'light' : 'dark') : theme;
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themePreference = theme;
  }, [theme, resolvedTheme]);

  useEffect(() => {
    setMenuOpen(false);
  }, [route.path]);

  const capabilities = useApiQuery<Capabilities>(qk.capabilities(), (client) => client.get('/v1/capabilities'), {
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
  const project = useApiQuery<ProjectSummary>(
    qk.project(projectId ?? 'none'),
    (client) => client.get(`/v1/projects/${projectId}`),
    { enabled: Boolean(projectId) },
  );

  useEffect(() => {
    if (projectId) localStorage.setItem('promptlens.lastProjectId', projectId);
  }, [projectId]);
  const health = useApiQuery<ProjectHealth>(
    qk.health(projectId ?? 'none'),
    (client) => client.get(`/v1/projects/${projectId}/health`),
    { enabled: Boolean(projectId), refetchInterval: 20_000 },
  );

  const coreOnline = capabilities.isSuccess;

  return (
    <div className="app">
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <Link to="/" className="brand" onClick={() => setMenuOpen(false)} ariaCurrent={route.name === 'workspace'}>
          <div className="brand-mark">PL</div>
          <div>
            <div className="brand-name">PromptLens</div>
            <div className="brand-sub">提示镜</div>
          </div>
        </Link>

        <nav className="list" aria-label="主导航">
          <NavItem to="/" active={route.name === 'workspace'} icon="◧" onClick={() => setMenuOpen(false)}>
            工作区
          </NavItem>
          <NavItem to="/models" active={route.name === 'models'} icon="◈" onClick={() => setMenuOpen(false)}>
            模型中心
          </NavItem>
          <NavItem to="/settings" active={route.name === 'settings'} icon="⚙" onClick={() => setMenuOpen(false)}>
            设置
          </NavItem>
        </nav>

        {projectId ? (
          <>
            <div className="nav-section">项目</div>
            <div className="small dim" style={{ padding: '0 10px 6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={projectId}>
              {project.data?.name ?? projectId}
            </div>
            <nav className="list" aria-label="项目导航">
              <NavItem to={projectPath(projectId)} active={route.name === 'project'} icon="▤">
                项目首页
              </NavItem>
              <NavItem to={projectPath(projectId, '/prompts')} active={route.name === 'prompts'} icon="✎">
                提示词实验室
              </NavItem>
              <NavItem to={projectPath(projectId, '/cases')} active={route.name === 'cases'} icon="▦">
                用例库
              </NavItem>
              <NavItem to={projectPath(projectId, '/eval-profiles')} active={route.name === 'evalProfiles'} icon="◍">
                评分方案
              </NavItem>
              <NavItem to={projectPath(projectId, '/suggestions')} active={route.name === 'suggestions'} icon="✦">
                优化建议
              </NavItem>
              <NavItem to={projectPath(projectId, '/experiments/new')} active={route.name === 'wizard'} icon="⚗">
                新建实验
              </NavItem>
              <NavItem to={projectPath(projectId, '/runs')} active={route.name === 'runs' || route.name === 'run' || route.name === 'compare'} icon="▶">
                运行
              </NavItem>
              <NavItem to={projectPath(projectId, '/analytics')} active={route.name === 'analytics'} icon="◔">
                分析
              </NavItem>
              <NavItem to={projectPath(projectId, '/reports')} active={route.name === 'reports'} icon="▥">
                报告
              </NavItem>
            </nav>
          </>
        ) : null}

        <div className="sidebar-footer">
          <div className="small dim" style={{ padding: '0 8px' }}>
            <span className={`dot ${coreOnline ? 'ok' : capabilities.isLoading ? 'warn' : 'error'}`} />{' '}
            {coreOnline ? `核心 ${capabilities.data?.serverVersion}` : capabilities.isLoading ? '连接中…' : '核心未连接'}
          </div>
          <div className="small dim" style={{ padding: '0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={capabilities.data?.workspace}>
            {capabilities.data?.workspace ?? '本地优先 · 数据不出机'}
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <Button variant="ghost" size="small" className="mobile-menu" onClick={() => setMenuOpen((value) => !value)} aria-label="切换菜单">
            ☰
          </Button>
          <div className="crumbs">
            <Link to="/" ariaCurrent={route.name === 'workspace'}>
              PromptLens
            </Link>
            {project.data ? (
              <>
                <span>/</span>
                <Link to={projectPath(project.data.projectId)}>
                  <strong>{project.data.name}</strong>
                </Link>
              </>
            ) : null}
            <span>/</span>
            <span style={{ color: 'var(--text)' }}>{PAGE_TITLES[route.name] ?? ''}</span>
          </div>
          <div className="topbar-actions">
            {health.data ? (
              <Badge tone={health.data.status === 'ok' ? 'ok' : health.data.status === 'degraded' ? 'warn' : 'error'}>
                <HealthDot status={health.data.status} /> 项目{health.data.status === 'ok' ? '健康' : health.data.status === 'degraded' ? '降级' : '异常'}
              </Badge>
            ) : null}
            <Button
              variant="ghost"
              size="small"
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              title={theme === 'system' ? `跟随系统（当前${resolvedTheme === 'dark' ? '深色' : '浅色'}），点击固定主题` : '切换主题'}
            >
              {resolvedTheme === 'dark' ? '☾' : '☀'}
            </Button>
          </div>
        </header>

        <main className="content">
          {capabilities.isError ? (
            <div className="notice error" role="alert" style={{ marginBottom: 16 }}>
              <div style={{ flex: 1 }}>
                <strong>本地核心服务不可达</strong>
                <div className="small">
                  {capabilities.error instanceof Error ? capabilities.error.message : '请确认桌面应用或开发服务已启动。'}
                </div>
              </div>
              <Button
                size="small"
                onClick={() => {
                  resetClient();
                  void capabilities.refetch();
                }}
              >
                重新连接
              </Button>
            </div>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}

function NavItem({ to, active, icon, children, onClick }: { to: string; active: boolean; icon: string; children: ReactNode; onClick?: () => void }) {
  return (
    <Link to={to} className={`nav-item ${active ? 'active' : ''}`} onClick={onClick} ariaCurrent={active}>
      <span className="nav-icon" aria-hidden>
        {icon}
      </span>
      {children}
    </Link>
  );
}

export async function coreClient() {
  return getClient();
}
