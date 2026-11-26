import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { CoreClient } from '@promptlens/api-client';
import { getClient } from './bridge';

export const qk = {
  capabilities: () => ['capabilities'] as const,
  appConfig: () => ['app-config'] as const,
  mcpInfo: (projectId: string, scopes: string) => ['mcp-info', projectId, scopes] as const,
  projects: () => ['projects'] as const,
  project: (projectId: string) => ['project', projectId] as const,
  health: (projectId: string) => ['health', projectId] as const,
  settings: (projectId: string) => ['project-settings', projectId] as const,
  overview: (projectId: string) => ['overview', projectId] as const,
  prompts: (projectId: string) => ['prompts', projectId] as const,
  promptVersion: (projectId: string, versionId: string) => ['prompt-version', projectId, versionId] as const,
  cases: (projectId: string, query: string, page: number) => ['cases', projectId, query, page] as const,
  testSets: (projectId: string) => ['testsets', projectId] as const,
  testSet: (projectId: string, versionId: string) => ['testset', projectId, versionId] as const,
  library: (query = '') => ['library', query] as const,
  models: (projectId: string) => ['models', projectId] as const,
  modelLibrary: () => ['model-library'] as const,
  evalProfiles: (projectId: string) => ['eval-profiles', projectId] as const,
  drafts: (projectId: string) => ['drafts', projectId] as const,
  runs: (projectId: string, status: string, page: number, extra = '') => ['runs', projectId, status, extra, page] as const,
  run: (projectId: string, runId: string) => ['run', projectId, runId] as const,
  runCost: (projectId: string, runId: string) => ['run-cost', projectId, runId] as const,
  evaluations: (projectId: string, runId: string) => ['evaluations', projectId, runId] as const,
  promptSuggestions: (projectId: string, runId: string) => ['prompt-suggestions', projectId, runId] as const,
  projectPromptSuggestions: (projectId: string, status: string) => ['prompt-suggestions-project', projectId, status] as const,
  reports: (projectId: string) => ['reports', projectId] as const,
  report: (projectId: string, reportId: string) => ['report', projectId, reportId] as const,
  analytics: (projectId: string) => ['analytics', projectId] as const,
  audit: (projectId: string) => ['audit', projectId] as const,
};

export interface QueryOptions {
  enabled?: boolean;
  refetchInterval?: number | false;
  staleTime?: number;
}

export function useApiQuery<T>(key: QueryKey, run: (client: CoreClient) => Promise<T>, options: QueryOptions = {}) {
  return useQuery<T>({
    queryKey: key,
    queryFn: async () => run(await getClient()),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval,
    staleTime: options.staleTime ?? 4000,
    retry: (count: number, error: unknown) => {
      const code = (error as { code?: string })?.code;
      if (code === 'INTEGRATION_CORE_UNREACHABLE') return count < 2;
      return count < 1;
    },
  });
}

export function useApiMutation<T, V = void>(
  run: (client: CoreClient, variables: V) => Promise<T>,
  options: { invalidate?: (variables: V) => QueryKey[]; onSuccess?: (data: T, variables: V) => void; onError?: (error: unknown, variables: V) => void } = {},
) {
  const queryClient = useQueryClient();
  return useMutation<T, unknown, V>({
    mutationFn: async (variables: V) => run(await getClient(), variables),
    onSuccess: (data, variables) => {
      for (const key of options.invalidate?.(variables) ?? []) queryClient.invalidateQueries({ queryKey: key });
      options.onSuccess?.(data, variables);
    },
    onError: (error, variables) => options.onError?.(error, variables),
  });
}

export function useQueryInvalidator() {
  const queryClient = useQueryClient();
  return (key: QueryKey) => queryClient.invalidateQueries({ queryKey: key });
}
