import { createInterface } from 'node:readline';
import { openProject, projectSummary, projectHealth, findProjectRoot } from '../core/project.js';
import { success, failure } from '../core/envelope.js';
import { createError, toPromptLensError } from '../core/errors.js';
import { API_VERSION, SERVER_VERSION, MCP_DEFAULT_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOL_VERSIONS } from '../version.js';
import { listPrompts, getPromptVersion, addVariant, restorePromptVersion, diffPromptVersions } from '../core/assets.js';
import { listCases, getTestSetByName, listTestSets, getTestSetVersion, importCases } from '../core/cases.js';
import { generateCases } from '../core/case-generation.js';
import { listModels, findModelByName, getModelConfigVersion, testConnection } from '../core/models.js';
import { addModel, probeModels } from '../core/models.js';
import { preflight } from '../core/spec.js';
import { createRun, executeRun, getRun, cancelRun, deriveRetryRun } from '../core/run.js';
import { generateReport, getReport, listReports, exportReport } from '../core/report.js';
import { proposePromptIteration } from '../core/prompt-iteration.js';
import {
  suggestPromptOptimizations,
  listPromptSuggestions,
  buildSuggestionContext,
  updatePromptSuggestionStatus,
} from '../core/prompt-suggestions.js';
import { listLibrary, getLibraryEntry, importLibraryEntry, promoteTestSet } from '../core/library.js';
import { createEvaluationProfile, listEvaluationProfiles, getEvaluationProfileVersion } from '../eval/profile.js';
import { listRuns, projectAnalytics, listAuditEvents, runCostSummary } from '../core/insights.js';
import {
  backupProject,
  createRecoveryCopy,
  listRecoveryCopies,
  listTrash,
  renameProject,
  restoreTrash,
  setProjectArchived,
  projectSettings,
  updateProjectSettings,
} from '../core/project-admin.js';
import { catalogSummary } from '../core/errors.js';

const SCOPES = {
  read: ['project:read', 'run:read'],
  write: ['run:write', 'project:write'],
};

export async function startMcpServer({ projectRoot, scopes }) {
  const ctx = openProject(projectRoot ?? findProjectRoot(process.cwd()) ?? '.');
  ctx.actor = 'mcp';
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const state = { initialized: false, protocolVersion: null };

  return new Promise((resolve) => {
    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      try {
        const response = await handleMessage(ctx, state, message, scopes ?? []);
        if (response !== undefined) write(response);
      } catch (error) {
        write({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: error?.message ?? 'Internal error' } });
      }
    });
    rl.on('close', () => {
      ctx.close();
      resolve();
    });
  });
}

async function handleMessage(ctx, state, message, scopes) {
  if (message?.jsonrpc !== '2.0' || typeof message?.method !== 'string') {
    if (message?.id !== undefined) {
      return { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    }
    return undefined;
  }
  const { id, method, params } = message;
  const isNotification = id === undefined;

  if (method === 'initialize') {
    const requested = params?.protocolVersion ?? MCP_DEFAULT_PROTOCOL_VERSION;
    if (!MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Unsupported protocol version', data: { supported: MCP_SUPPORTED_PROTOCOL_VERSIONS } },
      };
    }
    state.initialized = true;
    state.protocolVersion = requested;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: { name: 'promptlens', version: SERVER_VERSION },
      },
    };
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) return undefined;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (!state.initialized) {
    return { jsonrpc: '2.0', id, error: { code: -32002, message: 'Server not initialized', data: { hint: 'send initialize first' } } };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } };
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const tool = TOOL_DEFINITIONS.find((item) => item.name === name);
    if (!tool) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
    }
    const envelope = await callTool(ctx, name, args, scopes);
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: summarize(envelope) }],
        structuredContent: envelope,
        isError: !envelope.ok,
      },
    };
  }
  if (method === 'resources/list') {
    return { jsonrpc: '2.0', id, result: { resources: listResources(ctx) } };
  }
  if (method === 'resources/read') {
    const resource = readResource(ctx, params?.uri);
    if (!resource) return { jsonrpc: '2.0', id, error: { code: -32002, message: `Resource not found: ${params?.uri}` } };
    return { jsonrpc: '2.0', id, result: { contents: [resource] } };
  }
  if (method === 'prompts/list') {
    return { jsonrpc: '2.0', id, result: { prompts: [] } };
  }
  if (isNotification) return undefined;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

async function callTool(ctx, name, args, scopes) {
  try {
    const data = await executeTool(ctx, name, args, scopes);
    return success(data);
  } catch (error) {
    return failure(toPromptLensError(error), { withTrace: true });
  }
}

async function executeTool(ctx, name, args, scopes) {
  const requireScope = (scope) => {
    if (!scopes.includes(scope)) {
      throw createError('INTEGRATION_MCP_UNAUTHORIZED', { message: `MCP 连接缺少 scope: ${scope}` });
    }
  };
  switch (name) {
    case 'promptlens_projects_list':
      return { projects: [projectSummary(ctx)] };
    case 'promptlens_project_get':
      return projectHealth(ctx);
    case 'promptlens_prompts_list':
      return { prompts: listPrompts(ctx) };
    case 'promptlens_prompt_get':
      return getPromptVersion(ctx, args.promptVersionId);
    case 'promptlens_cases_list':
      return args.setName ? getTestSetByName(ctx, args.setName) : { cases: listCases(ctx) };
    case 'promptlens_testsets_list':
      return { testSets: listTestSets(ctx) };
    case 'promptlens_models_list':
      return { models: listModels(ctx) };
    case 'promptlens_model_add': {
      requireScope('project:write');
      return addModel(ctx, args);
    }
    case 'promptlens_model_test': {
      requireScope('project:read');
      return testConnection(ctx, args.model);
    }
    case 'promptlens_run_preflight': {
      requireScope('run:read');
      const plan = preflight(ctx, args.spec);
      return { snapshotHash: plan.snapshotHash, trialCount: plan.trialCount, plan: plan.plan, estimate: plan.estimate, warnings: plan.warnings, risks: plan.risks };
    }
    case 'promptlens_run_start': {
      requireScope('run:write');
      const created = createRun(ctx, args.spec, { idempotencyKey: args.idempotencyKey });
      if (created.status === 'queued' && !created.reused) {
        void executeRun(ctx, created.runId).catch(() => {});
      }
      return created;
    }
    case 'promptlens_run_get':
      requireScope('run:read');
      return getRun(ctx, args.runId, { includeOutputs: Boolean(args.includeOutputs) });
    case 'promptlens_run_events':
      requireScope('run:read');
      return { events: getRun(ctx, args.runId, { includeOutputs: true }).events.filter((event) => event.seq > Number(args.afterSeq ?? 0)) };
    case 'promptlens_run_cancel':
      requireScope('run:write');
      return cancelRun(ctx, args.runId);
    case 'promptlens_run_retry_failed': {
      requireScope('run:write');
      const created = deriveRetryRun(ctx, args.runId);
      void executeRun(ctx, created.runId).catch(() => {});
      return created;
    }
    case 'promptlens_report_generate':
      requireScope('run:write');
      return generateReport(ctx, args.runId);
    case 'promptlens_report_get': {
      requireScope('run:read');
      const { report, markdown } = getReport(ctx, args.reportId);
      if (markdown && markdown.length > 60_000) {
        return { report, markdown: `${markdown.slice(0, 60_000)}\n…（内容过长，请用 CLI report export 获取完整报告）`, markdownTruncated: true };
      }
      return { report, markdown };
    }
    case 'promptlens_reports_list':
      requireScope('run:read');
      return { reports: listReports(ctx, args.runId ?? null) };
    case 'promptlens_report_export': {
      requireScope('run:write');
      return exportReport(ctx, args.reportId, args.targetPath);
    }
    case 'promptlens_prompt_add_variant': {
      requireScope('project:write');
      return addVariant(ctx, args);
    }
    case 'promptlens_prompt_restore': {
      requireScope('project:write');
      return restorePromptVersion(ctx, args.versionId);
    }
    case 'promptlens_prompt_diff': {
      requireScope('project:read');
      return diffPromptVersions(ctx, args.leftVersionId, args.rightVersionId);
    }
    case 'promptlens_prompt_iterate': {
      requireScope('run:write');
      return proposePromptIteration(ctx, args);
    }
    case 'promptlens_cases_import': {
      requireScope('project:write');
      return importCases(ctx, { records: args.records, setName: args.setName, source: 'mcp' });
    }
    case 'promptlens_cases_generate': {
      requireScope('project:read');
      return generateCases(ctx, args);
    }
    case 'promptlens_testsets_get': {
      requireScope('project:read');
      return getTestSetVersion(ctx, args.testSetVersionId);
    }
    case 'promptlens_library_list':
      return { entries: listLibrary({ home: ctx.home ?? undefined, query: args.query ?? '' }) };
    case 'promptlens_library_get':
      return getLibraryEntry(args.libraryId, { home: ctx.home ?? undefined });
    case 'promptlens_library_promote': {
      requireScope('project:write');
      return promoteTestSet(ctx, args);
    }
    case 'promptlens_library_import': {
      requireScope('project:write');
      return importLibraryEntry(ctx, args);
    }
    case 'promptlens_eval_profiles_list':
      return { profiles: listEvaluationProfiles(ctx) };
    case 'promptlens_eval_profile_get':
      return getEvaluationProfileVersion(ctx, args.profileVersionId);
    case 'promptlens_eval_profile_create': {
      requireScope('project:write');
      return createEvaluationProfile(ctx, { name: args.name, config: args.config, template: args.template });
    }
    case 'promptlens_suggestions_context': {
      requireScope('run:read');
      return buildSuggestionContext(ctx, args);
    }
    case 'promptlens_suggestions_generate': {
      requireScope('run:write');
      return suggestPromptOptimizations(ctx, args);
    }
    case 'promptlens_suggestions_list':
      return { suggestions: listPromptSuggestions(ctx, args) };
    case 'promptlens_suggestions_status': {
      requireScope('project:write');
      return updatePromptSuggestionStatus(ctx, args.suggestionId, args.status);
    }
    case 'promptlens_runs_list':
      return listRuns(ctx, args);
    case 'promptlens_run_cost':
      return runCostSummary(ctx, args.runId);
    case 'promptlens_analytics':
      return projectAnalytics(ctx, { limit: args.limit ?? 30 });
    case 'promptlens_audit_events':
      return listAuditEvents(ctx, { limit: args.limit ?? 50, offset: args.offset ?? 0 });
    case 'promptlens_project_settings_get':
      return { projectId: ctx.projectId, settings: projectSettings(ctx) };
    case 'promptlens_project_settings_patch': {
      requireScope('project:write');
      return { projectId: ctx.projectId, settings: updateProjectSettings(ctx, args) };
    }
    case 'promptlens_project_rename': {
      requireScope('project:write');
      return renameProject(ctx, args.name);
    }
    case 'promptlens_project_archive': {
      requireScope('project:write');
      return setProjectArchived(ctx, Boolean(args.archived));
    }
    case 'promptlens_project_backup': {
      requireScope('project:write');
      return backupProject(ctx, { home: ctx.home ?? undefined, destination: args.destination ?? null });
    }
    case 'promptlens_project_recovery': {
      requireScope('project:write');
      return createRecoveryCopy({ root: ctx.root, home: ctx.home ?? undefined, destination: args.destination ?? null });
    }
    case 'promptlens_recovery_list':
      return { copies: listRecoveryCopies(ctx.home ?? undefined) };
    case 'promptlens_trash_list':
      return { entries: listTrash(ctx.home ?? undefined) };
    case 'promptlens_trash_restore': {
      requireScope('project:write');
      return restoreTrash(ctx.home ?? undefined, args.projectId);
    }
    case 'promptlens_capabilities_get':
      return capabilities();
    default:
      throw createError('VALIDATION_INVALID_REQUEST', { message: `未知工具: ${name}` });
  }
}

function capabilities() {
  return {
    apiVersion: API_VERSION,
    serverVersion: SERVER_VERSION,
    scopes: [...SCOPES.read, ...SCOPES.write],
    mcp: {
      defaultProtocolVersion: MCP_DEFAULT_PROTOCOL_VERSION,
      supportedProtocolVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
      transports: ['stdio'],
    },
    limits: { maxVariants: 20, maxModels: 32, maxRepetitions: 20, maxAttempts: 10 },
    errorCodes: catalogSummary(),
  };
}

function listResources(ctx) {
  const projectId = ctx.projectId;
  const resources = [
    { uri: `promptlens://projects/${projectId}/summary`, name: '项目摘要', mimeType: 'application/json' },
  ];
  const runs = ctx.db.prepare('SELECT id FROM runs ORDER BY created_at DESC LIMIT 20').all();
  for (const run of runs) {
    resources.push({ uri: `promptlens://projects/${projectId}/runs/${run.id}`, name: `运行 ${run.id}`, mimeType: 'application/json' });
  }
  const reports = ctx.db.prepare('SELECT id FROM reports ORDER BY generated_at DESC LIMIT 20').all();
  for (const report of reports) {
    resources.push({ uri: `promptlens://projects/${projectId}/reports/${report.id}`, name: `报告 ${report.id}`, mimeType: 'application/json' });
  }
  return resources;
}

function readResource(ctx, uri) {
  const match = /^promptlens:\/\/projects\/([^/]+)\/(summary|runs\/[^/]+|reports\/[^/]+)$/.exec(String(uri ?? ''));
  if (!match) return null;
  if (match[1] !== ctx.projectId) return null;
  const target = match[2];
  if (target === 'summary') {
    return { uri, mimeType: 'application/json', text: JSON.stringify(projectSummary(ctx), null, 2) };
  }
  if (target.startsWith('runs/')) {
    const runId = target.slice(5);
    return { uri, mimeType: 'application/json', text: JSON.stringify(getRun(ctx, runId, { includeOutputs: true }), null, 2) };
  }
  const reportId = target.slice(8);
  return { uri, mimeType: 'application/json', text: JSON.stringify(getReport(ctx, reportId), null, 2) };
}

function summarize(envelope) {
  if (!envelope.ok) return `失败 ${envelope.error.code}: ${envelope.error.message}`;
  const data = envelope.data ?? {};
  if (data.runId) return `运行 ${data.runId} 当前状态 ${data.status ?? data.run?.status ?? 'unknown'}。`;
  if (data.reportId) return `已生成报告 ${data.reportId}，路径 ${data.path}。`;
  if (data.projects) return `项目 ${data.projects[0]?.name ?? ''}（${data.projects[0]?.projectId ?? ''}）。`;
  return `操作成功，请求 ${envelope.requestId}。`;
}

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export const TOOL_DEFINITIONS = [
  { name: 'promptlens_projects_list', description: '列出当前项目摘要', inputSchema: { type: 'object', properties: {} } },
  { name: 'promptlens_project_get', description: '获取项目健康与统计', inputSchema: { type: 'object', properties: {} } },
  { name: 'promptlens_prompts_list', description: '列出提示词与版本', inputSchema: { type: 'object', properties: {} } },
  { name: 'promptlens_prompt_get', description: '获取提示词版本内容', inputSchema: { type: 'object', properties: { promptVersionId: { type: 'string' } }, required: ['promptVersionId'] } },
  { name: 'promptlens_cases_list', description: '列出用例或测试集', inputSchema: { type: 'object', properties: { setName: { type: 'string' } } } },
  { name: 'promptlens_testsets_list', description: '列出测试集', inputSchema: { type: 'object', properties: {} } },
  { name: 'promptlens_models_list', description: '列出模型配置', inputSchema: { type: 'object', properties: {} } },
  { name: 'promptlens_model_add', description: '新增模型配置版本', inputSchema: { type: 'object', properties: { name: { type: 'string' }, providerType: { type: 'string' }, modelId: { type: 'string' }, baseUrl: { type: 'string' }, credentialRef: { type: 'string' }, params: { type: 'object' }, pricing: { type: 'object' } }, required: ['name', 'providerType', 'modelId'] } },
  { name: 'promptlens_model_test', description: '测试模型连接', inputSchema: { type: 'object', properties: { model: { type: 'string' } }, required: ['model'] } },
  { name: 'promptlens_run_preflight', description: '校验实验规格并预览试次与预算', inputSchema: { type: 'object', properties: { spec: { type: 'object' } }, required: ['spec'] } },
  { name: 'promptlens_run_start', description: '创建并启动运行', inputSchema: { type: 'object', properties: { spec: { type: 'object' }, idempotencyKey: { type: 'string' } }, required: ['spec'] } },
  { name: 'promptlens_run_get', description: '获取运行状态与计数', inputSchema: { type: 'object', properties: { runId: { type: 'string' }, includeOutputs: { type: 'boolean' } }, required: ['runId'] } },
  { name: 'promptlens_run_events', description: '获取运行事件', inputSchema: { type: 'object', properties: { runId: { type: 'string' }, afterSeq: { type: 'number' } }, required: ['runId'] } },
  { name: 'promptlens_run_cancel', description: '请求取消运行', inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] } },
  { name: 'promptlens_run_retry_failed', description: '派生重试失败 Trial 的运行', inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] } },
  { name: 'promptlens_report_generate', description: '为已结束运行生成 Markdown 报告', inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] } },
  { name: 'promptlens_report_get', description: '获取报告版本与正文', inputSchema: { type: 'object', properties: { reportId: { type: 'string' } }, required: ['reportId'] } },
  { name: 'promptlens_reports_list', description: '列出报告版本', inputSchema: { type: 'object', properties: { runId: { type: 'string' } } } },
  { name: 'promptlens_report_export', description: '导出报告 Markdown 到指定路径', inputSchema: { type: 'object', properties: { reportId: { type: 'string' }, targetPath: { type: 'string' } }, required: ['reportId', 'targetPath'] } },
  { name: 'promptlens_prompt_add_variant', description: '新增提示词分支版本', inputSchema: { type: 'object', properties: { promptName: { type: 'string' }, promptId: { type: 'string' }, label: { type: 'string' }, content: { type: 'string' } }, required: ['label', 'content'] } },
  { name: 'promptlens_prompt_restore', description: '恢复旧版本为新版本', inputSchema: { type: 'object', properties: { versionId: { type: 'string' } }, required: ['versionId'] } },
  { name: 'promptlens_prompt_diff', description: '比较两个提示词版本', inputSchema: { type: 'object', properties: { leftVersionId: { type: 'string' }, rightVersionId: { type: 'string' } }, required: ['leftVersionId', 'rightVersionId'] } },
  { name: 'promptlens_prompt_iterate', description: '基于运行结果生成提示词迭代候选', inputSchema: { type: 'object', properties: { runId: { type: 'string' }, modelConfigVersionId: { type: 'string' }, promptVersionId: { type: 'string' }, instruction: { type: 'string' }, rounds: { type: 'number' }, save: { type: 'boolean' }, verify: { type: 'boolean' }, inline: { type: 'boolean' } }, required: ['runId'] } },
  { name: 'promptlens_cases_import', description: '导入用例到测试集（原子提交）', inputSchema: { type: 'object', properties: { setName: { type: 'string' }, records: { type: 'array' } }, required: ['setName', 'records'] } },
  { name: 'promptlens_cases_generate', description: '用模型生成候选用例（不落库）', inputSchema: { type: 'object', properties: { modelConfigVersionId: { type: 'string' }, instruction: { type: 'string' }, count: { type: 'number' } }, required: ['instruction'] } },
  { name: 'promptlens_testsets_get', description: '获取测试集版本详情', inputSchema: { type: 'object', properties: { testSetVersionId: { type: 'string' } }, required: ['testSetVersionId'] } },
  { name: 'promptlens_library_list', description: '列出用例库', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'promptlens_library_get', description: '获取用例库条目', inputSchema: { type: 'object', properties: { libraryId: { type: 'string' } }, required: ['libraryId'] } },
  { name: 'promptlens_library_promote', description: '把测试集提升到用例库', inputSchema: { type: 'object', properties: { testSetVersionId: { type: 'string' }, setName: { type: 'string' }, license: { type: 'string' }, sensitive: { type: 'boolean' } }, required: ['testSetVersionId'] } },
  { name: 'promptlens_library_import', description: '从用例库导入测试集', inputSchema: { type: 'object', properties: { libraryId: { type: 'string' }, setName: { type: 'string' } }, required: ['libraryId'] } },
  { name: 'promptlens_eval_profiles_list', description: '列出评分方案', inputSchema: { type: 'object', properties: {} } },
  { name: 'promptlens_eval_profile_get', description: '获取评分方案版本', inputSchema: { type: 'object', properties: { profileVersionId: { type: 'string' } }, required: ['profileVersionId'] } },
  { name: 'promptlens_eval_profile_create', description: '创建评分方案版本', inputSchema: { type: 'object', properties: { name: { type: 'string' }, config: { type: 'object' }, template: { type: 'string' } }, required: ['name'] } },
  { name: 'promptlens_suggestions_context', description: '构建提示词优化建议上下文与成本预览', inputSchema: { type: 'object', properties: { runId: { type: 'string' }, modelConfigVersionId: { type: 'string' }, promptVersionId: { type: 'string' }, maxSuggestions: { type: 'number' } }, required: ['runId'] } },
  { name: 'promptlens_suggestions_generate', description: '生成提示词优化建议（保存建议）', inputSchema: { type: 'object', properties: { runId: { type: 'string' }, modelConfigVersionId: { type: 'string' }, promptVersionId: { type: 'string' }, focus: { type: 'string' }, maxSuggestions: { type: 'number' } }, required: ['runId'] } },
  { name: 'promptlens_suggestions_list', description: '列出优化建议', inputSchema: { type: 'object', properties: { runId: { type: 'string' }, promptVersionId: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'promptlens_suggestions_status', description: '更新优化建议状态', inputSchema: { type: 'object', properties: { suggestionId: { type: 'string' }, status: { type: 'string' } }, required: ['suggestionId', 'status'] } },
  { name: 'promptlens_runs_list', description: '列出运行历史', inputSchema: { type: 'object', properties: { status: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } } } },
  { name: 'promptlens_run_cost', description: '获取运行成本汇总（含 judge）', inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] } },
  { name: 'promptlens_analytics', description: '获取项目趋势分析', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'promptlens_audit_events', description: '列出审计事件', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, offset: { type: 'number' } } } },
  { name: 'promptlens_project_settings_get', description: '读取项目设置', inputSchema: { type: 'object', properties: {} } },
  { name: 'promptlens_project_settings_patch', description: '更新项目设置（含敏感字段）', inputSchema: { type: 'object', properties: { autoReport: { type: 'boolean' }, autoExport: { type: 'boolean' }, sensitiveFields: { type: 'array' } } } },
  { name: 'promptlens_project_rename', description: '重命名项目', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'promptlens_project_archive', description: '归档或取消归档项目', inputSchema: { type: 'object', properties: { archived: { type: 'boolean' } }, required: ['archived'] } },
  { name: 'promptlens_project_backup', description: '生成项目便携备份', inputSchema: { type: 'object', properties: { destination: { type: 'string' } } } },
  { name: 'promptlens_project_recovery', description: '生成只读恢复副本与恢复清单', inputSchema: { type: 'object', properties: { destination: { type: 'string' } } } },
  { name: 'promptlens_recovery_list', description: '列出恢复副本', inputSchema: { type: 'object', properties: {} } },
  { name: 'promptlens_trash_list', description: '列出回收站项目', inputSchema: { type: 'object', properties: {} } },
  { name: 'promptlens_trash_restore', description: '从回收站恢复项目', inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] } },
  { name: 'promptlens_capabilities_get', description: '获取协议版本、scope、限制和错误码', inputSchema: { type: 'object', properties: {} } },
];
