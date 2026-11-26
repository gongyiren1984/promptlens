import { createError, catalogSummary } from '../core/errors.js';
import { API_VERSION, SERVER_VERSION, MCP_DEFAULT_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOL_VERSIONS, PRODUCT_NAME } from '../version.js';
import { projectSummary } from '../core/project.js';
import { listPrompts, createPrompt, addVariant, getPromptVersion, diffPromptVersions, ensurePrompt, restorePromptVersion } from '../core/assets.js';
import { listCases, listTestSets, getTestSetVersion } from '../core/cases.js';
import { getLibraryEntry, importLibraryEntry, listLibrary, promoteTestSet, testSetOrigin } from '../core/library.js';
import { createImportPreview, commitImportPreview } from '../core/import-preview.js';
import { addModel, listModels, testConnection, probeModels } from '../core/models.js';
import { deleteModelLibraryEntry, importModelLibraryEntry, readModelLibrary, saveModelLibraryEntry } from '../core/model-library.js';
import { createEvaluationProfile, listEvaluationProfiles, getEvaluationProfileVersion } from '../eval/profile.js';
import { preflight } from '../core/spec.js';
import { createRun, cancelRun, deriveRetryRun, executeRun } from '../core/run.js';
import { generateReport, listReports, getReport, exportReport, REQUIRED_SECTIONS } from '../core/report.js';
import { listEvaluations } from '../eval/engine.js';
import { listRuns, runBundle, runCostSummary, projectAnalytics, listAuditEvents } from '../core/insights.js';
import { listDrafts, createDraft, updateDraft, deleteDraft } from '../core/drafts.js';
import { spawnRunWorker } from '../core/worker.js';
import { newIdempotencyKey } from '../core/ids.js';
import { finalizeRunArtifacts } from '../core/auto-report.js';
import { generateCases } from '../core/case-generation.js';
import { recordAudit } from '../core/audit.js';
import { readAppConfig, updateAppConfig } from '../core/app-config.js';
import { storeKeychainCredential } from '../core/credentials.js';
import { mcpInfo } from '../mcp/info.js';
import { proposePromptIteration, buildIterationContext } from '../core/prompt-iteration.js';
import { suggestPromptOptimizations, listPromptSuggestions, getPromptSuggestion, buildSuggestionContext, updatePromptSuggestionStatus } from '../core/prompt-suggestions.js';
import {
  backupProject,
  createRecoveryCopy,
  deleteProject,
  importProject,
  listRecoveryCopies,
  listTrash,
  projectSettings,
  renameProject,
  restoreBackup,
  restoreTrash,
  setProjectArchived,
  updateProjectSettings,
} from '../core/project-admin.js';

const ROUTES = [
  { method: 'GET', path: '/v1/health', auth: false, handler: health },
  { method: 'GET', path: '/v1/capabilities', handler: capabilities },
  { method: 'GET', path: '/v1/app/config', handler: appConfigGet },
  { method: 'PATCH', path: '/v1/app/config', handler: appConfigPatch },
  { method: 'POST', path: '/v1/credentials/keychain', handler: credentialStoreKeychain },

  { method: 'GET', path: '/v1/projects', handler: listProjects },
  { method: 'POST', path: '/v1/projects', handler: createProjectRoute },
  { method: 'POST', path: '/v1/projects/open', handler: openProjectRoute },
  { method: 'GET', path: '/v1/projects/:projectId', handler: projectDetail },
  { method: 'GET', path: '/v1/projects/:projectId/health', handler: projectHealthRoute },
  { method: 'GET', path: '/v1/projects/:projectId/overview', handler: projectOverview },
  { method: 'POST', path: '/v1/projects/:projectId/rename', handler: projectRename },
  { method: 'POST', path: '/v1/projects/:projectId/archive', handler: projectArchive },
  { method: 'GET', path: '/v1/projects/:projectId/settings', handler: projectSettingsGet },
  { method: 'PATCH', path: '/v1/projects/:projectId/settings', handler: projectSettingsPatch },
  { method: 'POST', path: '/v1/projects/:projectId/backup', handler: projectBackup },
  { method: 'POST', path: '/v1/projects/:projectId/recovery', handler: projectRecovery },
  { method: 'GET', path: '/v1/recovery', handler: recoveryList },
  { method: 'POST', path: '/v1/projects/locate', handler: projectLocate },
  { method: 'POST', path: '/v1/projects/:projectId/delete', handler: projectDelete },
  { method: 'POST', path: '/v1/projects/import', handler: projectImport },
  { method: 'POST', path: '/v1/projects/restore-backup', handler: projectRestoreBackup },
  { method: 'GET', path: '/v1/trash', handler: trashList },
  { method: 'POST', path: '/v1/trash/:projectId/restore', handler: trashRestore },

  { method: 'GET', path: '/v1/projects/:projectId/prompts', handler: promptsList },
  { method: 'POST', path: '/v1/projects/:projectId/prompts', handler: promptsCreate },
  { method: 'POST', path: '/v1/projects/:projectId/prompts/:promptId/variants', handler: promptVariantCreate },
  { method: 'GET', path: '/v1/projects/:projectId/prompt-versions/:versionId', handler: promptVersion },
  { method: 'POST', path: '/v1/projects/:projectId/prompt-versions/:versionId/restore', handler: promptVersionRestore },
  { method: 'GET', path: '/v1/projects/:projectId/prompt-diff', handler: promptDiff },

  { method: 'GET', path: '/v1/projects/:projectId/cases', handler: casesList },
  { method: 'POST', path: '/v1/projects/:projectId/cases/import/preview', handler: casesPreview },
  { method: 'POST', path: '/v1/projects/:projectId/cases/import/commit', handler: casesCommit },
  { method: 'POST', path: '/v1/projects/:projectId/cases/generate', handler: casesGenerate },

  { method: 'GET', path: '/v1/projects/:projectId/testsets', handler: testSetsList },
  { method: 'GET', path: '/v1/projects/:projectId/testsets/:versionId', handler: testSetDetail },
  { method: 'POST', path: '/v1/projects/:projectId/testsets/:versionId/promote', handler: testSetPromote },
  { method: 'POST', path: '/v1/projects/:projectId/library/:libraryId/import', handler: libraryImport },

  { method: 'GET', path: '/v1/library', handler: libraryList },
  { method: 'GET', path: '/v1/library/:libraryId', handler: libraryDetail },

  { method: 'GET', path: '/v1/projects/:projectId/models', handler: modelsList },
  { method: 'POST', path: '/v1/projects/:projectId/models', handler: modelsCreate },
  { method: 'POST', path: '/v1/projects/:projectId/models/:ref/test', handler: modelsTest },
  { method: 'POST', path: '/v1/projects/:projectId/models/:ref/probe', handler: modelsProbe },
  { method: 'POST', path: '/v1/projects/:projectId/models/from-library', handler: modelsImportFromLibrary },
  { method: 'GET', path: '/v1/projects/:projectId/mcp-info', handler: mcpProjectInfo },

  { method: 'GET', path: '/v1/model-library', handler: modelLibraryList },
  { method: 'POST', path: '/v1/model-library', handler: modelLibrarySave },
  { method: 'DELETE', path: '/v1/model-library/:id', handler: modelLibraryDelete },

  { method: 'GET', path: '/v1/projects/:projectId/eval-profiles', handler: evalProfilesList },
  { method: 'POST', path: '/v1/projects/:projectId/eval-profiles', handler: evalProfilesCreate },
  { method: 'GET', path: '/v1/projects/:projectId/eval-profiles/:versionId', handler: evalProfileDetail },

  { method: 'GET', path: '/v1/projects/:projectId/drafts', handler: draftsList },
  { method: 'POST', path: '/v1/projects/:projectId/drafts', handler: draftsCreate },
  { method: 'PATCH', path: '/v1/projects/:projectId/drafts/:draftId', handler: draftsUpdate },
  { method: 'DELETE', path: '/v1/projects/:projectId/drafts/:draftId', handler: draftsDelete },

  { method: 'POST', path: '/v1/projects/:projectId/runs/preflight', handler: runsPreflight },
  { method: 'GET', path: '/v1/projects/:projectId/runs', handler: runsList },
  { method: 'POST', path: '/v1/projects/:projectId/runs', handler: runsCreate },
  { method: 'GET', path: '/v1/projects/:projectId/runs/:runId', handler: runDetail },
  { method: 'GET', path: '/v1/projects/:projectId/runs/:runId/trials', handler: runTrials },
  { method: 'GET', path: '/v1/projects/:projectId/runs/:runId/evaluations', handler: runEvaluations },
  { method: 'GET', path: '/v1/projects/:projectId/runs/:runId/cost', handler: runCost },
  { method: 'POST', path: '/v1/projects/:projectId/runs/:runId/cancel', handler: runCancel },
  { method: 'POST', path: '/v1/projects/:projectId/runs/:runId/retry-failed', handler: runRetryFailed },
  { method: 'POST', path: '/v1/projects/:projectId/runs/:runId/prompt-iteration', handler: runPromptIteration },
  { method: 'GET', path: '/v1/projects/:projectId/runs/:runId/prompt-iteration/context', handler: runPromptIterationContext },
  { method: 'POST', path: '/v1/projects/:projectId/runs/:runId/prompt-suggestions', handler: runPromptSuggestions },
  { method: 'GET', path: '/v1/projects/:projectId/runs/:runId/prompt-suggestions', handler: runPromptSuggestionsList },
  { method: 'GET', path: '/v1/projects/:projectId/runs/:runId/prompt-suggestions/context', handler: runPromptSuggestionsContext },
  { method: 'GET', path: '/v1/projects/:projectId/prompt-suggestions', handler: promptSuggestionsList },
  { method: 'GET', path: '/v1/projects/:projectId/prompt-suggestions/:suggestionId', handler: promptSuggestionDetail },
  { method: 'PATCH', path: '/v1/projects/:projectId/prompt-suggestions/:suggestionId', handler: promptSuggestionStatus },

  { method: 'GET', path: '/v1/projects/:projectId/reports', handler: reportsList },
  { method: 'POST', path: '/v1/projects/:projectId/reports', handler: reportsCreate },
  { method: 'GET', path: '/v1/projects/:projectId/reports/:reportId', handler: reportDetail },
  { method: 'POST', path: '/v1/projects/:projectId/reports/:reportId/export', handler: reportExport },

  { method: 'GET', path: '/v1/projects/:projectId/analytics', handler: analytics },
  { method: 'GET', path: '/v1/projects/:projectId/audit', handler: audit },

  { method: 'GET', path: '/v1/runs/:runId', handler: runDetailCrossProject },
  { method: 'GET', path: '/v1/reports/:reportId', handler: reportDetailCrossProject },
];

export function matchRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const routeParts = route.path.split('/').filter(Boolean);
    if (routeParts.length !== parts.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < routeParts.length; i++) {
      const expected = routeParts[i];
      if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(parts[i]);
      else if (expected !== parts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

export function listRoutePaths() {
  return ROUTES.map((route) => `${route.method} ${route.path}`);
}

/* ---------------- 基础 ---------------- */

function health() {
  return { data: { status: 'ok', apiVersion: API_VERSION, serverVersion: SERVER_VERSION, product: PRODUCT_NAME } };
}

function capabilities(request) {
  const workspace = request.registry.workspace;
  return {
    data: {
      product: PRODUCT_NAME,
      apiVersion: API_VERSION,
      serverVersion: SERVER_VERSION,
      transport: { type: 'loopback', host: request.server.host, port: request.server.port },
      workspace,
      mcp: {
        defaultProtocolVersion: MCP_DEFAULT_PROTOCOL_VERSION,
        supportedProtocolVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
        transports: ['stdio'],
      },
      limits: {
        maxVariants: 20,
        maxModels: 32,
        maxRepetitions: 20,
        maxAttempts: 10,
        maxConcurrency: 256,
        maxFallbacksPerModel: 5,
        maxDialogueRounds: 20,
        maxDialogueOutputTokensPerTurn: 32768,
        maxBodyBytes: request.server.maxBodyBytes,
        maxPageSize: 200,
        maxReportMarkdownBytes: 64 * 1024,
      },
      errorCodes: catalogSummary(),
      routes: listRoutePaths(),
      report: { requiredSections: REQUIRED_SECTIONS },
      features: {
        sse: true,
        drafts: true,
        importPreview: true,
        dialogue: true,
        analytics: 'client-side',
      },
      time: new Date().toISOString(),
    },
  };
}

/* ---------------- 项目 ---------------- */

function listProjects(request) {
  return { data: request.registry.list() };
}

function appConfigGet(request) {
  return { data: readAppConfig(request.registry.home) };
}

function appConfigPatch(request) {
  const body = request.body ?? {};
  if (typeof body.workspaceRoot === 'string' && body.workspaceRoot.trim()) {
    request.registry.setWorkspace(body.workspaceRoot);
  }
  return { data: updateAppConfig(request.registry.home, body) };
}

function credentialStoreKeychain(request) {
  const body = request.body ?? {};
  return { data: storeKeychainCredential({ key: body.key, account: body.account }) };
}

function mcpProjectInfo(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const scopes = String(request.query?.scopes ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  return { data: mcpInfo({ projectRoot: ctx.root, ...(scopes.length ? { scopes } : {}) }) };
}

function createProjectRoute(request) {
  const body = request.body ?? {};
  requireString(body.path, 'path');
  if (!body.name) throw createError('VALIDATION_INVALID_REQUEST', { message: '创建项目需要 name。' });
  return { data: request.registry.create({ path: body.path, name: body.name }) };
}

function openProjectRoute(request) {
  const body = request.body ?? {};
  const path = body.path ?? body.projectId;
  requireString(path, 'path');
  if (body.projectId && !body.path) {
    request.registry.ctx(body.projectId);
    return { data: { ...projectSummary(request.registry.ctx(body.projectId)), created: false } };
  }
  return { data: request.registry.openByPath(path) };
}

function projectDetail(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: projectSummary(ctx) };
}

function projectHealthRoute(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: request.registry.health(request.params.projectId) };
}

function projectOverview(request) {
  const projectId = request.params.projectId;
  const ctx = request.registry.ctx(projectId);
  const runs = listRuns(ctx, { limit: 6 });
  const reports = listReports(ctx).slice(0, 5);
  const analytics = projectAnalytics(ctx, { limit: 20 });
  return {
    data: {
      summary: projectSummary(ctx),
      health: request.registry.health(projectId),
      recentRuns: runs.runs,
      runTotal: runs.total,
      recentReports: reports,
      analytics: analytics.totals,
      lastRunAt: runs.runs[0]?.createdAt ?? null,
    },
    warnings: runs.runs.some((run) => run.cost.unknownCount > 0)
      ? [{ code: 'PRICE_INCOMPLETE', message: '最近运行包含未知价格，成本合计不完整。' }]
      : [],
  };
}

/* ---------------- 项目生命周期 ---------------- */

function projectRename(request) {
  const body = request.body ?? {};
  requireString(body.name, 'name');
  const ctx = request.registry.ctx(request.params.projectId);
  const renamed = renameProject(ctx, body.name);
  request.registry.touch(renamed.projectId, renamed.root, renamed.name);
  return { data: renamed };
}

function projectArchive(request) {
  const body = request.body ?? {};
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: setProjectArchived(ctx, body.archived !== false) };
}

function projectSettingsGet(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: { projectId: ctx.projectId, settings: projectSettings(ctx) } };
}

function projectSettingsPatch(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: { projectId: ctx.projectId, settings: updateProjectSettings(ctx, request.body ?? {}) } };
}

function projectBackup(request) {
  const body = request.body ?? {};
  const ctx = request.registry.ctx(request.params.projectId);
  const backup = backupProject(ctx, { home: request.registry.home, destination: body.destination ?? null });
  return {
    data: backup,
    warnings: backup.bytes > 64 * 1024 * 1024 ? [{ code: 'BACKUP_LARGE', message: `备份体积 ${(backup.bytes / 1024 / 1024).toFixed(1)} MB，请确认目标磁盘空间。` }] : [],
  };
}

function projectRecovery(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  const copy = createRecoveryCopy({ root: ctx.root, home: request.registry.home, destination: body.destination ?? null });
  return {
    data: copy,
    warnings:
      copy.databaseStatus !== 'readable'
        ? [{ code: 'RECOVERY_PARTIAL', message: `项目数据库状态为 ${copy.databaseStatus}，恢复清单仅列出可用资产，请在只读模式下人工核对。` }]
        : [],
  };
}

function recoveryList(request) {
  return { data: { copies: listRecoveryCopies(request.registry.home) } };
}

function projectLocate(request) {
  const body = request.body ?? {};
  requireString(body.projectId, 'projectId');
  const located = request.registry.locate(body.projectId, body.searchRoot ?? request.registry.workspace);
  return { data: located };
}

function projectDelete(request) {
  const body = request.body ?? {};
  const projectId = request.params.projectId;
  const ctx = request.registry.ctx(projectId);
  const root = ctx.root;
  recordAudit(ctx, 'project.deleted', { projectId, permanent: Boolean(body.permanent), root });
  request.registry.closeProject(projectId);
  const result = deleteProject({
    root,
    home: request.registry.home,
    permanent: Boolean(body.permanent),
    confirmProjectId: body.confirmProjectId ?? null,
  });
  request.registry.forget(projectId);
  return { data: result };
}

function projectImport(request) {
  const body = request.body ?? {};
  requireString(body.source, 'source');
  requireString(body.destination, 'destination');
  const summary = importProject({ source: body.source, destination: body.destination });
  const opened = request.registry.openByPath(summary.root);
  return { data: { ...opened, files: summary.files, bytes: summary.bytes, importedFrom: summary.importedFrom } };
}

function projectRestoreBackup(request) {
  const body = request.body ?? {};
  requireString(body.backup, 'backup');
  requireString(body.destination, 'destination');
  const summary = restoreBackup({ backup: body.backup, destination: body.destination });
  const opened = request.registry.openByPath(summary.root);
  return { data: { ...opened, backup: summary.backup } };
}

function trashList(request) {
  return { data: { entries: listTrash(request.registry.home) } };
}

function trashRestore(request) {
  const restored = restoreTrash(request.registry.home, request.params.projectId);
  const opened = request.registry.openByPath(restored.restoredTo);
  return { data: { ...restored, project: opened } };
}

/* ---------------- 提示词 ---------------- */

function promptsList(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: { prompts: listPrompts(ctx) } };
}

function promptsCreate(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  requireString(body.name, 'name');
  if (body.label && body.content) {
    ensurePrompt(ctx, { name: body.name, description: body.description ?? null });
    const variant = addVariant(ctx, { promptName: body.name, label: body.label, content: body.content });
    return { data: { promptId: variant.promptId, name: variant.promptName, variant } };
  }
  const created = createPrompt(ctx, { name: body.name, description: body.description ?? null });
  return { data: { ...created, variant: null } };
}

function promptVariantCreate(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  requireString(body.label, 'label');
  requireString(body.content, 'content');
  return { data: addVariant(ctx, { promptId: request.params.promptId, label: body.label, content: body.content }) };
}

function promptVersion(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: getPromptVersion(ctx, request.params.versionId) };
}

function promptVersionRestore(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: restorePromptVersion(ctx, request.params.versionId) };
}

function promptDiff(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const { left, right } = request.query;
  if (!left || !right) throw createError('VALIDATION_INVALID_REQUEST', { message: 'diff 需要 left 与 right 版本 ID。' });
  return { data: diffPromptVersions(ctx, left, right) };
}

/* ---------------- 用例与测试集 ---------------- */

function casesList(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const all = listCases(ctx);
  const q = String(request.query.q ?? '').trim().toLowerCase();
  const filtered = q
    ? all.filter((item) => JSON.stringify(item.input).toLowerCase().includes(q) || String(item.caseVersionId).toLowerCase().includes(q))
    : all;
  const limit = queryNumber(request.query.limit, 50, 1, 200);
  const offset = queryNumber(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  return { data: { total: filtered.length, limit, offset, cases: filtered.slice(offset, offset + limit) } };
}

function casesPreview(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  return { data: createImportPreview(ctx, { text: body.text, format: body.format, setName: body.setName ?? null, mapping: body.mapping ?? null }) };
}

function casesCommit(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  return { data: commitImportPreview(ctx, { previewId: body.previewId, setName: body.setName ?? null, duplicatePolicy: body.duplicatePolicy ?? 'reuse' }) };
}

async function casesGenerate(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  const generated = await generateCases(ctx, {
    modelConfigVersionId: body.modelConfigVersionId ?? null,
    modelRef: body.modelRef ?? null,
    instruction: body.instruction,
    count: body.count ?? 10,
  });
  const text = generated.records.map((record) => JSON.stringify(record)).join('\n');
  const preview = text
    ? createImportPreview(ctx, { text, format: 'jsonl', setName: body.setName ?? 'AI 生成集' })
    : { previewId: null, validRecords: 0, totalRecords: 0, errorCount: generated.errors.length, sample: [] };
  return {
    data: {
      preview,
      records: generated.records,
      generator: generated.generator,
      cost: generated.cost,
      usage: generated.usage,
      duplicateCandidates: generated.duplicateCandidates,
      errors: generated.errors,
    },
    warnings: generated.warnings,
  };
}

function testSetsList(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const testSets = listTestSets(ctx).map((set) => ({
    ...set,
    versions: set.versions.map((version) => ({ ...version, origin: testSetOrigin(ctx, version.testSetVersionId) })),
  }));
  return { data: { testSets } };
}

function testSetDetail(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const detail = getTestSetVersion(ctx, request.params.versionId);
  return { data: { ...detail, origin: testSetOrigin(ctx, request.params.versionId) } };
}

function testSetPromote(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  return {
    data: promoteTestSet(ctx, {
      testSetVersionId: request.params.versionId,
      setName: body.setName ?? null,
      license: body.license ?? null,
      sensitive: Boolean(body.sensitive),
      home: request.registry.home,
    }),
  };
}

function libraryList(request) {
  return { data: listLibrary({ home: request.registry.home, query: request.query.q ?? '' }) };
}

function libraryDetail(request) {
  return { data: getLibraryEntry(request.params.libraryId, { home: request.registry.home }) };
}

function libraryImport(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  const result = importLibraryEntry(ctx, {
    libraryId: request.params.libraryId,
    setName: body.setName ?? null,
    home: request.registry.home,
  });
  return { data: result, warnings: result.warnings };
}

/* ---------------- 模型 ---------------- */

function modelsList(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: { models: listModels(ctx) } };
}

function modelsCreate(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  return {
    data: addModel(ctx, {
      name: body.name,
      providerType: body.providerType,
      modelId: body.modelId,
      baseUrl: body.baseUrl ?? null,
      credentialRef: body.credentialRef ?? null,
      params: body.params ?? {},
      pricing: body.pricing ?? null,
    }),
  };
}

async function modelsTest(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: await testConnection(ctx, request.params.ref) };
}

async function modelsProbe(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: await probeModels(ctx, request.params.ref) };
}

/* ---------------- 跨项目模型库 ---------------- */

function modelsImportFromLibrary(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  if (!body.libraryId) throw createError('VALIDATION_INVALID_REQUEST', { message: '从模型库导入需要 libraryId。' });
  return { data: importModelLibraryEntry(ctx, request.registry.home, body.libraryId, { name: body.name }) };
}

function modelLibraryList(request) {
  return { data: readModelLibrary(request.registry.home) };
}

function modelLibrarySave(request) {
  return { data: saveModelLibraryEntry(request.registry.home, request.body ?? {}) };
}

function modelLibraryDelete(request) {
  return { data: deleteModelLibraryEntry(request.registry.home, request.params.id) };
}

/* ---------------- 评分方案 ---------------- */

function evalProfilesList(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: { profiles: listEvaluationProfiles(ctx) } };
}

function evalProfilesCreate(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  requireString(body.name, 'name');
  const template = body.template === 'default' ? 'default' : null;
  return { data: createEvaluationProfile(ctx, { name: body.name, config: body.config, template }) };
}

function evalProfileDetail(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: getEvaluationProfileVersion(ctx, request.params.versionId) };
}

/* ---------------- 草稿 ---------------- */

function draftsList(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: { drafts: listDrafts(ctx) } };
}

function draftsCreate(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: createDraft(ctx, request.body ?? {}) };
}

function draftsUpdate(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: updateDraft(ctx, request.params.draftId, request.body ?? {}) };
}

function draftsDelete(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: deleteDraft(ctx, request.params.draftId) };
}

/* ---------------- 运行 ---------------- */

function runsPreflight(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  const plan = preflight(ctx, body.spec);
  return {
    data: {
      snapshotHash: plan.snapshotHash,
      trialCount: plan.trialCount,
      plan: plan.plan,
      estimate: plan.estimate,
      warnings: plan.warnings,
      risks: plan.risks,
      snapshot: body.includeSnapshot ? plan.snapshot : undefined,
    },
    warnings: plan.warnings,
  };
}

function runsList(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return {
    data: listRuns(ctx, {
      status: request.query.status ? String(request.query.status) : null,
      from: request.query.from ? String(request.query.from) : null,
      to: normalizeUpperBound(request.query.to),
      modelConfigVersionId: request.query.modelConfigVersionId ? String(request.query.modelConfigVersionId) : null,
      variantVersionId: request.query.variantVersionId ? String(request.query.variantVersionId) : null,
      limit: queryNumber(request.query.limit, 20, 1, 200),
      offset: queryNumber(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    }),
  };
}

/** 形如 2026-11-26 的上界补到当天结束，避免用户以为包含当天却漏掉。 */
function normalizeUpperBound(value) {
  if (!value) return null;
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T23:59:59.999Z` : text;
}

async function runsCreate(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  const idempotencyKey = body.idempotencyKey || request.headers['idempotency-key'] || newIdempotencyKey();
  const created = await createRun(ctx, body.spec, { idempotencyKey });
  if (body.inline) {
    const executed = await executeRun(ctx, created.runId);
    const artifacts = finalizeRunArtifacts(ctx, created.runId);
    return { data: { ...created, ...executed, artifacts }, warnings: created.warnings ?? [] };
  }
  const worker = created.reused && created.status !== 'queued' ? null : spawnRunWorker(ctx.root, created.runId);
  return {
    data: { ...created, status: created.status ?? 'queued', detached: true, worker },
    warnings: created.warnings ?? [],
  };
}

function runDetail(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: runBundle(ctx, request.params.runId, bundleOptions(request.query)) };
}

function runDetailCrossProject(request) {
  const projectId = request.registry.projectIdForRun(request.params.runId);
  const ctx = request.registry.ctx(projectId);
  return { data: { projectId, ...runBundle(ctx, request.params.runId, bundleOptions(request.query)) } };
}

function runTrials(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const bundle = runBundle(ctx, request.params.runId, bundleOptions(request.query));
  return { data: { runId: request.params.runId, counts: bundle.counts, trialTotal: bundle.trialTotal, trials: bundle.trials, labels: bundle.labels } };
}

function runEvaluations(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const all = listEvaluations(ctx, request.params.runId);
  const limit = queryNumber(request.query.limit, 200, 1, 1000);
  const offset = queryNumber(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  return { data: { total: all.length, limit, offset, evaluations: all.slice(offset, offset + limit) } };
}

function runCost(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: runCostSummary(ctx, request.params.runId) };
}

function runCancel(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: cancelRun(ctx, request.params.runId, { modelConfigVersionId: request.body?.modelConfigVersionId ?? null }) };
}

function runPromptIterationContext(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const query = request.query ?? {};
  const result = buildIterationContext(ctx, {
    runId: request.params.runId,
    modelConfigVersionId: query.modelConfigVersionId ?? null,
    modelRef: query.modelRef ?? query.model ?? null,
    promptVersionId: query.promptVersionId ?? null,
    rounds: query.rounds ?? 1,
  });
  return { data: result };
}

async function runPromptSuggestions(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  const data = await suggestPromptOptimizations(ctx, {
    runId: request.params.runId,
    modelConfigVersionId: body.modelConfigVersionId ?? null,
    modelRef: body.modelRef ?? null,
    promptVersionId: body.promptVersionId ?? null,
    focus: body.focus ?? '',
    maxSuggestions: body.maxSuggestions ?? 3,
  });
  return {
    data,
    warnings: [{ code: 'PROMPT_UNCHANGED', message: '优化建议是独立保存的内容，不会修改任何提示词版本。' }],
  };
}

function runPromptSuggestionsList(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const query = request.query ?? {};
  return {
    data: {
      suggestions: listPromptSuggestions(ctx, {
        runId: request.params.runId,
        promptVersionId: query.promptVersionId ?? null,
        limit: query.limit ?? 50,
      }),
    },
  };
}

function runPromptSuggestionsContext(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const query = request.query ?? {};
  return {
    data: buildSuggestionContext(ctx, {
      runId: request.params.runId,
      modelConfigVersionId: query.modelConfigVersionId ?? null,
      modelRef: query.modelRef ?? query.model ?? null,
      promptVersionId: query.promptVersionId ?? null,
      maxSuggestions: query.maxSuggestions ?? 3,
    }),
  };
}

function promptSuggestionsList(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const query = request.query ?? {};
  return {
    data: {
      suggestions: listPromptSuggestions(ctx, {
        runId: query.runId ?? null,
        promptVersionId: query.promptVersionId ?? null,
        status: query.status ?? null,
        limit: query.limit ?? 50,
      }),
    },
  };
}

function promptSuggestionStatus(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  requireString(body.status, 'status');
  return { data: updatePromptSuggestionStatus(ctx, request.params.suggestionId, body.status) };
}

function promptSuggestionDetail(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: getPromptSuggestion(ctx, request.params.suggestionId) };
}

async function runPromptIteration(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  const result = await proposePromptIteration(ctx, {
    runId: request.params.runId,
    modelConfigVersionId: body.modelConfigVersionId ?? null,
    modelRef: body.modelRef ?? null,
    promptVersionId: body.promptVersionId ?? null,
    instruction: body.instruction ?? '',
    label: body.label ?? null,
    rounds: body.rounds ?? 1,
    save: Boolean(body.save),
    verify: Boolean(body.verify),
    inline: Boolean(body.inline),
  });
  const warnings = [];
  if (!result.proposal?.created) warnings.push({ code: 'ITERATION_NOT_SAVED', message: '改进稿尚未写入新版本，确认后使用 save=true 保存。' });
  return { data: result, warnings };
}

async function runRetryFailed(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const created = await deriveRetryRun(ctx, request.params.runId);
  if (request.body?.inline) {
    const executed = await executeRun(ctx, created.runId);
    const artifacts = finalizeRunArtifacts(ctx, created.runId);
    return { data: { ...created, ...executed, artifacts } };
  }
  const worker = spawnRunWorker(ctx.root, created.runId);
  return { data: { ...created, detached: true, worker } };
}

function bundleOptions(query) {
  return {
    trialLimit: queryNumber(query.trialLimit, 200, 1, 2000),
    trialOffset: queryNumber(query.trialOffset, 0, 0, Number.MAX_SAFE_INTEGER),
    includeOutputs: query.includeOutputs === '1' || query.includeOutputs === 'true',
  };
}

/* ---------------- 报告 ---------------- */

function reportsList(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: { reports: listReports(ctx, request.query.runId ?? null) } };
}

function reportsCreate(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  requireString(body.runId, 'runId');
  return { data: generateReport(ctx, body.runId, {}) };
}

function reportDetail(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const { report, markdown } = getReport(ctx, request.params.reportId);
  return { data: { report, markdown } };
}

function reportDetailCrossProject(request) {
  const projectId = request.registry.reportIdToProject(request.params.reportId);
  const ctx = request.registry.ctx(projectId);
  const { report, markdown } = getReport(ctx, request.params.reportId);
  return { data: { projectId, report, markdown } };
}

function reportExport(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  const body = request.body ?? {};
  requireString(body.path, 'path');
  return { data: exportReport(ctx, request.params.reportId, body.path) };
}

/* ---------------- 分析与审计 ---------------- */

function analytics(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: projectAnalytics(ctx, { limit: queryNumber(request.query.limit, 30, 1, 100) }) };
}

function audit(request) {
  const ctx = request.registry.ctx(request.params.projectId);
  return { data: listAuditEvents(ctx, { limit: queryNumber(request.query.limit, 50, 1, 200), offset: queryNumber(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER) }) };
}

/* ---------------- 工具 ---------------- */

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: `字段 ${field} 不能为空。` });
  }
}

function queryNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
