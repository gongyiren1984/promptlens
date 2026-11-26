import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AppConfig } from '@promptlens/contracts';
import { AppShell } from '../components/layout';
import { Button, useToast, ToastProvider } from '../components/ui';
import { setWarningHandler } from '../api/bridge';
import { qk, useApiMutation, useApiQuery } from '../api/hooks';
import { navigate, useRoute } from './router';
import { TourOverlay, TOUR_VERSION } from '../features/tour/TourOverlay';
import { WorkspacePage } from '../features/workspace/WorkspacePage';
import { ProjectHomePage } from '../features/project/ProjectHomePage';
import { PromptsPage } from '../features/prompts/PromptsPage';
import { CasesPage } from '../features/cases/CasesPage';
import { EvalProfilesPage } from '../features/evaluation/EvalProfilesPage';
import { SuggestionHistoryPage } from '../features/suggestions/SuggestionHistoryPage';
import { WizardPage } from '../features/experiments/WizardPage';
import { RunsPage } from '../features/runs/RunsPage';
import { RunMonitorPage } from '../features/runs/RunMonitorPage';
import { ComparePage } from '../features/runs/ComparePage';
import { AnalyticsPage } from '../features/analytics/AnalyticsPage';
import { ReportsPage } from '../features/reports/ReportsPage';
import { ModelsPage } from '../features/models/ModelsPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { OnboardingPage } from '../features/onboarding/OnboardingPage';
import { AboutPage, NoticesPage, PrivacyPage, TermsPage } from '../features/legal/LegalPages';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: true,
      staleTime: 4000,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WarningBridge />
        <ErrorBoundary>
          <AppGate />
        </ErrorBoundary>
      </ToastProvider>
    </QueryClientProvider>
  );
}

function WarningBridge() {
  const { push } = useToast();
  useEffect(() => {
    setWarningHandler((warnings) => {
      for (const warning of warnings) push(warning.message, 'warn', warning.code);
    });
    return () => setWarningHandler(null);
  }, [push]);
  return null;
}

function AppGate() {
  const route = useRoute();
  const { push } = useToast();
  const config = useApiQuery<AppConfig>(qk.appConfig(), (client) => client.get('/v1/app/config'));
  const completeTour = useApiMutation(
    (client) => client.patch<AppConfig>('/v1/app/config', { tour: { completedVersion: TOUR_VERSION } }),
    {
      invalidate: () => [qk.appConfig()],
      onError: (error) => push((error as Error).message, 'error'),
    },
  );
  useEffect(() => {
    if (!config.isSuccess) return;
    const incomplete = !config.data.onboarding.completedAt && !config.data.onboarding.skipped;
    const legalRoute = ['privacy', 'terms', 'notices', 'about'].includes(route.name);
    if (incomplete && route.name !== 'onboarding' && !legalRoute) navigate('/onboarding');
  }, [config.isSuccess, config.data, route.name]);

  const showTour =
    config.isSuccess &&
    Boolean(config.data.onboarding.completedAt || config.data.onboarding.skipped) &&
    (config.data.tour.completedVersion ?? 0) < TOUR_VERSION;

  if (route.name === 'onboarding') return <OnboardingPage />;
  return (
    <AppShell>
      <Routes />
      {showTour ? <TourOverlay open onComplete={() => completeTour.mutate()} /> : null}
    </AppShell>
  );
}

function Routes() {
  const route = useRoute();
  const projectId = route.params.projectId;
  switch (route.name) {
    case 'workspace':
      return <WorkspacePage />;
    case 'models':
      return <ModelsPage />;
    case 'settings':
      return <SettingsPage projectId={projectId ?? null} />;
    case 'about':
      return <AboutPage />;
    case 'privacy':
      return <PrivacyPage />;
    case 'terms':
      return <TermsPage />;
    case 'notices':
      return <NoticesPage />;
    case 'project':
      return <ProjectHomePage projectId={projectId} />;
    case 'prompts':
      return <PromptsPage projectId={projectId} />;
    case 'cases':
      return <CasesPage projectId={projectId} />;
    case 'evalProfiles':
      return <EvalProfilesPage projectId={projectId} />;
    case 'suggestions':
      return <SuggestionHistoryPage projectId={projectId} />;
    case 'wizard':
      return <WizardPage projectId={projectId} />;
    case 'runs':
      return <RunsPage projectId={projectId} />;
    case 'run':
      return <RunMonitorPage projectId={projectId} runId={route.params.runId} />;
    case 'compare':
      return <ComparePage projectId={projectId} runId={route.params.runId} />;
    case 'analytics':
      return <AnalyticsPage projectId={projectId} />;
    case 'reports':
      return <ReportsPage projectId={projectId} />;
    default:
      return (
        <div className="page">
          <h1>页面不存在</h1>
          <p className="dim">路径：{route.path}</p>
          <a className="btn" href="#/">
            返回工作区
          </a>
        </div>
      );
  }
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('界面异常', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="page" style={{ paddingTop: 60 }}>
          <div className="notice error" role="alert">
            <div className="stack" style={{ gap: 6 }}>
              <strong>界面渲染失败</strong>
              <span className="small mono">{this.state.error.message}</span>
              <span className="small dim">可刷新界面恢复；连续出现请导出诊断信息并反馈。</span>
              <div className="row">
                <Button variant="primary" onClick={() => window.location.reload()}>
                  刷新界面
                </Button>
                <Button onClick={() => this.setState({ error: null })}>尝试继续</Button>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
