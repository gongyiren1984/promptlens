import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openProject, createProject, projectHealth, projectSummary, discoverProjects, MANIFEST_NAME } from '../core/project.js';
import { success, failure, exitCodeForEnvelope } from '../core/envelope.js';
import { toPromptLensError, createError, catalogSummary } from '../core/errors.js';
import { recordAudit } from '../core/audit.js';
import { nowIso, parseDuration } from '../core/time.js';
import { API_VERSION, SERVER_VERSION, MCP_DEFAULT_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOL_VERSIONS } from '../version.js';
import { importPrompts, listPrompts, getPromptVersion, diffPromptVersions, addVariant, ensurePrompt, extractVariables, restorePromptVersion } from '../core/assets.js';
import { parseCasesFile, importCases, listTestSets, getTestSetVersion, listCases, getTestSetByName } from '../core/cases.js';
import { generateCases } from '../core/case-generation.js';
import { proposePromptIteration } from '../core/prompt-iteration.js';
import { suggestPromptOptimizations, listPromptSuggestions, buildSuggestionContext, updatePromptSuggestionStatus } from '../core/prompt-suggestions.js';
import { createImportPreview, commitImportPreview } from '../core/import-preview.js';
import { getLibraryEntry, importLibraryEntry, listLibrary, promoteTestSet } from '../core/library.js';
import { addModel, listModels, testConnection, probeModels, findModelByName } from '../core/models.js';
import {
  readModelLibrary,
  saveModelLibraryEntry,
  deleteModelLibraryEntry,
  importModelLibraryEntry,
} from '../core/model-library.js';
import { storeKeychainCredential } from '../core/credentials.js';
import { mcpInfo } from '../mcp/info.js';
import { createEvaluationProfile, listEvaluationProfiles, getEvaluationProfileVersion, findEvaluationProfileByName } from '../eval/profile.js';
import { loadSpecFile, preflight } from '../core/spec.js';
import { createRun, executeRun, getRun, cancelRun, waitRun, deriveRetryRun } from '../core/run.js';
import { generateReport, getReport, listReports, exportReport, DEFAULT_TEMPLATE, validateTemplate } from '../core/report.js';
import { parseYaml } from '../core/yaml.js';
import { readFileSync as readText } from 'node:fs';
import { parseYaml as parseYamlText } from '../core/yaml.js';
import { spawnRunWorker } from '../core/worker.js';
import { finalizeRunArtifacts } from '../core/auto-report.js';
import { listRuns } from '../core/insights.js';
import {
  backupProject,
  createRecoveryCopy,
  defaultHome,
  deleteProject,
  importProject,
  listRecoveryCopies,
  listTrash,
  locateProjectRoot,
  projectSettings,
  renameProject,
  restoreBackup,
  restoreTrash,
  setProjectArchived,
  updateProjectSettings,
  updateRecentProject,
} from '../core/project-admin.js';

const VALUE_FLAGS = new Set([
  'project', 'spec', 'idempotency-key', 'timeout', 'output', 'file', 'set', 'name', 'description',
  'label', 'content', 'content-file', 'provider', 'model-id', 'base-url', 'credential', 'params',
  'pricing', 'template', 'template-file', 'path', 'dir', 'scope', 'run', 'scopes', 'limit', 'after',
  'port', 'host', 'token-file', 'workspace', 'origin', 'home', 'out', 'destination', 'confirm-project-id',
  'status', 'from', 'to', 'offset', 'model', 'instruction', 'count', 'duplicate-policy', 'prompt-version',
  'license', 'q', 'project-id', 'search', 'key', 'from-env', 'account', 'library-id',
]);

const BOOLEAN_FLAGS = new Set(['json', 'no-input', 'dry-run', 'quiet', 'verbose', 'foreground', 'outputs', 'help', 'permanent', 'auto-report', 'auto-export', 'commit', 'save', 'sensitive']);

export async function runCli(argv) {
  const started = Date.now();
  const { flags, positional } = parseArgv(argv);
  const requestId = undefined;
  if (flags.help || positional.length === 0) {
    return presentHelp(flags);
  }
  const [group, action, ...rest] = positional;
  try {
    const result = await dispatch(group, action, rest, flags);
    const envelope = success(result.data, {
      requestId,
      warnings: result.warnings ?? [],
      durationMs: Date.now() - started,
    });
    if (!result.quiet) writeOutput(envelope, flags, result.stdout);
    return 0;
  } catch (error) {
    const envelope = failure(error, { requestId, durationMs: Date.now() - started, withTrace: true });
    writeOutput(envelope, flags);
    if (!flags.quiet && !flags.json) process.stderr.write(`错误 ${envelope.error.code}: ${envelope.error.message}\n`);
    return exitCodeForEnvelope(envelope);
  }
}

function parseArgv(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags[body] = true;
      continue;
    }
    if (VALUE_FLAGS.has(body)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw createError('VALIDATION_INVALID_REQUEST', { message: `选项 --${body} 需要值。` });
      }
      flags[body] = next;
      i++;
      continue;
    }
    flags[body] = true;
  }
  return { flags, positional };
}

async function withProject(flags, fn) {
  const ctx = openProject(flags.project ?? '.');
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

async function dispatch(group, action, rest, flags) {
  switch (group) {
    case 'project':
      return projectCommand(action, rest, flags);
    case 'prompts':
      return promptCommand(action, rest, flags);
    case 'cases':
      return caseCommand(action, rest, flags);
    case 'testsets':
      return testSetCommand(action, rest, flags);
    case 'library':
      return libraryCommand(action, rest, flags);
    case 'models':
      return modelCommand(action, rest, flags);
    case 'model-library':
      return modelLibraryCommand(action, rest, flags);
    case 'eval-profiles':
      return evalProfileCommand(action, rest, flags);
    case 'run':
      return runCommand(action, rest, flags);
    case 'report':
      return reportCommand(action, rest, flags);
    case 'mcp':
      return mcpCommand(action, rest, flags);
    case 'serve':
      return serveCommand(flags);
    case 'capabilities':
      return capabilitiesCommand(flags);
    default:
      throw createError('VALIDATION_INVALID_REQUEST', { message: `未知命令组: ${group}` });
  }
}

function projectCommand(action, rest, flags) {
  if (action === 'create') {
    const path = rest[0] ?? flags.path;
    if (!path) throw createError('VALIDATION_INVALID_REQUEST', { message: 'project create 需要目录路径。' });
    if (!flags.name) throw createError('VALIDATION_INVALID_REQUEST', { message: 'project create 需要 --name。' });
    const { root, manifest } = createProject({ path, name: flags.name });
    return { data: { projectId: manifest.projectId, name: manifest.name, root, createdAt: manifest.createdAt } };
  }
  if (action === 'list') {
    const dir = resolve(flags.dir ?? '.');
    const projects = [];
    scanProjects(dir, 0, projects);
    return { data: { root: dir, projects } };
  }
  if (action === 'open') {
    const ref = rest[0] ?? flags.project;
    if (!ref) throw createError('VALIDATION_INVALID_REQUEST', { message: 'project open 需要项目路径或 ID。' });
    const direct = resolve(ref);
    const target = existsSync(direct) ? ref : findProjectIdPath(ref);
    return withProject({ project: target }, (ctx) => ({ data: projectSummary(ctx) }));
  }
  if (action === 'health' || action === 'show') {
    return withProject(flags, (ctx) => ({ data: projectHealth(ctx) }));
  }
  if (action === 'rename') {
    const name = rest[0] ?? flags.name;
    if (!name) throw createError('VALIDATION_INVALID_REQUEST', { message: 'project rename 需要新名称。' });
    return withProject(flags, (ctx) => ({ data: renameProject(ctx, name) }));
  }
  if (action === 'archive' || action === 'unarchive') {
    return withProject(flags, (ctx) => ({ data: setProjectArchived(ctx, action === 'archive') }));
  }
  if (action === 'settings') {
    return withProject(flags, (ctx) => {
      const patch = {};
      if (flags['auto-report'] !== undefined) patch.autoReport = flagBoolean(flags['auto-report']);
      if (flags['auto-export'] !== undefined) patch.autoExport = flagBoolean(flags['auto-export']);
      const settings = Object.keys(patch).length ? updateProjectSettings(ctx, patch) : projectSettings(ctx);
      return { data: { projectId: ctx.projectId, settings } };
    });
  }
  if (action === 'backup') {
    return withProject(flags, (ctx) => ({
      data: backupProject(ctx, {
        home: flags.home ? resolve(flags.home) : defaultHome(),
        destination: flags.out ?? flags.destination ?? null,
      }),
    }));
  }
  if (action === 'recover') {
    return withProject(flags, (ctx) => ({
      data: createRecoveryCopy({
        root: ctx.root,
        home: flags.home ? resolve(flags.home) : defaultHome(),
        destination: flags.out ?? flags.destination ?? null,
      }),
    }));
  }
  if (action === 'recovery-list') {
    return { data: { copies: listRecoveryCopies(flags.home ? resolve(flags.home) : defaultHome()) } };
  }
  if (action === 'locate') {
    const projectId = rest[0] ?? flags['project-id'];
    if (!projectId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'project locate 需要项目 ID。' });
    const searchRoot = flags.dir ?? flags.search ?? '.';
    const found = locateProjectRoot({ projectId, searchRoots: [searchRoot] });
    updateRecentProject(flags.home ? resolve(flags.home) : defaultHome(), found);
    return { data: found };
  }
  if (action === 'delete') {
    const ctx = openProject(flags.project ?? '.');
    const root = ctx.root;
    const projectId = ctx.projectId;
    recordAudit(ctx, 'project.deleted', { projectId, permanent: Boolean(flags.permanent), root });
    ctx.close();
    return {
      data: deleteProject({
        root,
        home: flags.home ? resolve(flags.home) : defaultHome(),
        permanent: Boolean(flags.permanent),
        confirmProjectId: flags['confirm-project-id'] ?? null,
      }),
    };
  }
  if (action === 'import') {
    const source = rest[0] ?? flags.source;
    const destination = rest[1] ?? flags.destination ?? flags.path;
    if (!source || !destination) throw createError('VALIDATION_INVALID_REQUEST', { message: 'project import 需要来源目录和目标目录。' });
    const imported = importProject({ source, destination });
    return { data: imported, warnings: imported.files ? [] : [{ code: 'EMPTY_IMPORT', message: '来源目录中未找到 PromptLens 资产。' }] };
  }
  if (action === 'restore-backup') {
    const backup = rest[0] ?? flags.source;
    const destination = rest[1] ?? flags.destination ?? flags.path;
    if (!backup || !destination) throw createError('VALIDATION_INVALID_REQUEST', { message: 'project restore-backup 需要备份目录和目标目录。' });
    return { data: restoreBackup({ backup, destination }) };
  }
  if (action === 'trash') {
    return { data: { entries: listTrash(flags.home ? resolve(flags.home) : defaultHome()) } };
  }
  if (action === 'restore') {
    const projectId = rest[0];
    if (!projectId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'project restore 需要回收站中的项目 ID。' });
    return { data: restoreTrash(flags.home ? resolve(flags.home) : defaultHome(), projectId) };
  }
  throw createError('VALIDATION_INVALID_REQUEST', { message: `未知 project 子命令: ${action}` });
}

function flagBoolean(value) {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw createError('VALIDATION_INVALID_REQUEST', { message: `布尔选项无法解析: ${value}` });
}

function scanProjects(dir, depth, out) {
  if (depth > 3) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((entry) => entry.isFile() && entry.name === MANIFEST_NAME)) {
    try {
      const ctx = openProject(dir);
      out.push(projectSummary(ctx));
      ctx.close();
    } catch {
      /* 跳过损坏项目 */
    }
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    scanProjects(join(dir, entry.name), depth + 1, out);
  }
}

function findProjectIdPath(projectId) {
  const found = [];
  scanProjects(resolve('.'), 0, found);
  const match = found.find((project) => project.projectId === projectId);
  if (!match) throw createError('NOT_FOUND_PROJECT', { message: `未在当前目录树找到项目 ${projectId}。` });
  return match.root;
}

function promptCommand(action, rest, flags) {
  if (action === 'import') {
    const file = flags.file;
    if (!file) throw createError('VALIDATION_INVALID_REQUEST', { message: 'prompts import 需要 --file。' });
    const document = parseJsonOrYamlFile(file);
    return withProject(flags, (ctx) => {
      if (flags['dry-run']) return { data: { dryRun: true, documents: Array.isArray(document) ? document.length : 1 } };
      const result = importPrompts(ctx, document);
      return { data: result };
    });
  }
  if (action === 'list') {
    return withProject(flags, (ctx) => ({ data: { prompts: listPrompts(ctx) } }));
  }
  if (action === 'show') {
    const versionId = rest[0];
    if (!versionId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'prompts show 需要 versionId。' });
    return withProject(flags, (ctx) => ({ data: getPromptVersion(ctx, versionId) }));
  }
  if (action === 'diff') {
    const [left, right] = rest;
    if (!left || !right) throw createError('VALIDATION_INVALID_REQUEST', { message: 'prompts diff 需要两个 versionId。' });
    return withProject(flags, (ctx) => ({ data: diffPromptVersions(ctx, left, right) }));
  }
  if (action === 'iterate') {
    const runId = flags.run ?? rest[0];
    if (!runId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'prompts iterate 需要 --run。' });
    if (!flags.model) throw createError('VALIDATION_INVALID_REQUEST', { message: 'prompts iterate 需要 --model（名称或配置版本 ID）。' });
    return withProject(flags, async (ctx) => ({
      data: await proposePromptIteration(ctx, {
        runId,
        modelRef: flags.model,
        promptVersionId: flags['prompt-version'] ?? null,
        instruction: flags.instruction ?? '',
        label: flags.label ?? null,
        rounds: flags.rounds ?? 1,
        save: Boolean(flags.save),
        verify: Boolean(flags.verify),
        inline: Boolean(flags.inline),
      }),
    }));
  }
  if (action === 'suggest') {
    const runId = flags.run ?? rest[0];
    if (!runId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'prompts suggest 需要 --run。' });
    if (!flags.model) throw createError('VALIDATION_INVALID_REQUEST', { message: 'prompts suggest 需要 --model（名称或配置版本 ID）。' });
    return withProject(flags, async (ctx) => ({
      data: await suggestPromptOptimizations(ctx, {
        runId,
        modelRef: flags.model,
        promptVersionId: flags['prompt-version'] ?? null,
        focus: flags.focus ?? '',
        maxSuggestions: flags.max ?? 3,
      }),
    }));
  }
  if (action === 'suggest-context') {
    const runId = flags.run ?? rest[0];
    if (!runId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'prompts suggest-context 需要 --run。' });
    if (!flags.model) throw createError('VALIDATION_INVALID_REQUEST', { message: 'prompts suggest-context 需要 --model。' });
    return withProject(flags, (ctx) => ({
      data: buildSuggestionContext(ctx, {
        runId,
        modelRef: flags.model,
        promptVersionId: flags['prompt-version'] ?? null,
        maxSuggestions: flags.max ?? 3,
      }),
    }));
  }
  if (action === 'suggestions') {
    return withProject(flags, (ctx) => ({
      data: {
        suggestions: listPromptSuggestions(ctx, {
          runId: flags.run ?? rest[0] ?? null,
          promptVersionId: flags['prompt-version'] ?? null,
          status: flags.status ?? null,
          limit: flags.limit ?? 50,
        }),
      },
    }));
  }
  if (action === 'suggestion-status') {
    const suggestionId = rest[0] ?? flags.id;
    if (!suggestionId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'prompts suggestion-status 需要 suggestionId。' });
    if (!flags.status) throw createError('VALIDATION_INVALID_REQUEST', { message: 'prompts suggestion-status 需要 --status（generated|accepted|dismissed）。' });
    return withProject(flags, (ctx) => ({ data: updatePromptSuggestionStatus(ctx, suggestionId, flags.status) }));
  }
  if (action === 'restore') {
    const versionId = rest[0] ?? flags.version;
    if (!versionId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'prompts restore 需要版本 ID。' });
    return withProject(flags, (ctx) => ({ data: restorePromptVersion(ctx, versionId) }));
  }
  if (action === 'add') {
    if (!flags.name || !flags.label) throw createError('VALIDATION_INVALID_REQUEST', { message: 'prompts add 需要 --name 与 --label。' });
    let content = flags.content;
    if (flags['content-file']) content = readText(flags['content-file'], 'utf8');
    if (!content) throw createError('VALIDATION_INVALID_REQUEST', { message: 'prompts add 需要 --content 或 --content-file。' });
    return withProject(flags, (ctx) => {
      ensurePrompt(ctx, { name: flags.name, description: flags.description ?? null });
      const result = addVariant(ctx, { promptName: flags.name, label: flags.label, content });
      return { data: result };
    });
  }
  throw createError('VALIDATION_INVALID_REQUEST', { message: `未知 prompts 子命令: ${action}` });
}

function caseCommand(action, rest, flags) {
  if (action === 'generate') {
    if (!flags.instruction) throw createError('VALIDATION_INVALID_REQUEST', { message: 'cases generate 需要 --instruction。' });
    if (!flags.model) throw createError('VALIDATION_INVALID_REQUEST', { message: 'cases generate 需要 --model（名称或配置版本 ID）。' });
    return withProject(flags, async (ctx) => {
      const generated = await generateCases(ctx, {
        modelRef: flags.model,
        instruction: flags.instruction,
        count: flags.count ? Number(flags.count) : 10,
      });
      const setName = flags.set ?? 'AI 生成集';
      if (flags['dry-run']) {
        return { data: { dryRun: true, generator: generated.generator, cost: generated.cost, records: generated.records, errors: generated.errors }, warnings: generated.warnings };
      }
      const text = generated.records.map((record) => JSON.stringify(record)).join('\n');
      if (!text) {
        return { data: { generator: generated.generator, cost: generated.cost, records: [], errors: generated.errors, preview: null }, warnings: generated.warnings };
      }
      const preview = createImportPreview(ctx, { text, format: 'jsonl', setName });
      if (flags.commit) {
        const committed = commitImportPreview(ctx, { previewId: preview.previewId, setName, duplicatePolicy: flags['duplicate-policy'] ?? 'reuse' });
        return { data: { generator: generated.generator, cost: generated.cost, preview, committed }, warnings: generated.warnings };
      }
      return { data: { generator: generated.generator, cost: generated.cost, preview, records: generated.records }, warnings: generated.warnings };
    });
  }
  if (action === 'import') {
    if (!flags.file) throw createError('VALIDATION_INVALID_REQUEST', { message: 'cases import 需要 --file。' });
    if (!flags.set) throw createError('VALIDATION_INVALID_REQUEST', { message: 'cases import 需要 --set。' });
    const records = parseCasesFile(flags.file);
    return withProject(flags, (ctx) => {
      if (flags['dry-run']) {
        return { data: { dryRun: true, records: records.length, setName: flags.set, source: flags.file } };
      }
      const result = importCases(ctx, { records, setName: flags.set, source: flags.file });
      return { data: result, warnings: result.duplicates ? [{ code: 'DUPLICATE_CASES', message: `${result.duplicates} 条用例已存在，已复用。` }] : [] };
    });
  }
  if (action === 'list') {
    return withProject(flags, (ctx) => {
      if (flags.set) {
        const set = getTestSetByName(ctx, flags.set);
        return { data: { testSetVersionId: set.testSetVersionId, cases: set.cases } };
      }
      return { data: { cases: listCases(ctx) } };
    });
  }
  throw createError('VALIDATION_INVALID_REQUEST', { message: `未知 cases 子命令: ${action}` });
}

function testSetCommand(action, rest, flags) {
  if (action === 'list') return withProject(flags, (ctx) => ({ data: { testSets: listTestSets(ctx) } }));
  if (action === 'show') {
    const versionId = rest[0];
    if (!versionId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'testsets show 需要 versionId。' });
    return withProject(flags, (ctx) => ({ data: getTestSetVersion(ctx, versionId) }));
  }
  if (action === 'find') {
    if (!flags.name) throw createError('VALIDATION_INVALID_REQUEST', { message: 'testsets find 需要 --name。' });
    return withProject(flags, (ctx) => ({ data: getTestSetByName(ctx, flags.name) }));
  }
  throw createError('VALIDATION_INVALID_REQUEST', { message: `未知 testsets 子命令: ${action}` });
}

function libraryCommand(action, rest, flags) {
  const home = flags.home ? resolve(flags.home) : defaultHome();
  if (action === 'list') return { data: listLibrary({ home, query: flags.q ?? '' }) };
  if (action === 'show') {
    const libraryId = rest[0];
    if (!libraryId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'library show 需要 libraryId。' });
    return { data: getLibraryEntry(libraryId, { home }) };
  }
  if (action === 'promote') {
    const versionId = rest[0];
    if (!versionId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'library promote 需要测试集版本 ID。' });
    return withProject(flags, (ctx) => ({
      data: promoteTestSet(ctx, {
        testSetVersionId: versionId,
        setName: flags.set ?? flags.name ?? null,
        license: flags.license ?? null,
        sensitive: Boolean(flags.sensitive),
        home,
      }),
    }));
  }
  if (action === 'import') {
    const libraryId = rest[0];
    if (!libraryId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'library import 需要 libraryId。' });
    return withProject(flags, (ctx) => {
      const result = importLibraryEntry(ctx, { libraryId, setName: flags.set ?? null, home });
      return { data: result, warnings: result.warnings };
    });
  }
  throw createError('VALIDATION_INVALID_REQUEST', { message: `未知 library 子命令: ${action}` });
}

function modelCommand(action, rest, flags) {
  if (action === 'add') {
    const pricing = flags.pricing ? JSON.parse(flags.pricing) : null;
    const params = flags.params ? JSON.parse(flags.params) : {};
    return withProject(flags, (ctx) => {
      const result = addModel(ctx, {
        name: flags.name,
        providerType: flags.provider,
        modelId: flags['model-id'],
        baseUrl: flags['base-url'] ?? null,
        credentialRef: flags.credential ?? null,
        params,
        pricing,
      });
      return { data: result };
    });
  }
  if (action === 'list') return withProject(flags, (ctx) => ({ data: { models: listModels(ctx) } }));
  if (action === 'show') {
    const ref = rest[0];
    if (!ref) throw createError('VALIDATION_INVALID_REQUEST', { message: 'models show 需要名称或版本 ID。' });
    return withProject(flags, (ctx) => ({ data: findModelByName(ctx, ref) }));
  }
  if (action === 'test') {
    const ref = rest[0];
    if (!ref) throw createError('VALIDATION_INVALID_REQUEST', { message: 'models test 需要名称或版本 ID。' });
    return withProject(flags, async (ctx) => ({ data: await testConnection(ctx, ref) }));
  }
  if (action === 'probe') {
    const ref = rest[0];
    if (!ref) throw createError('VALIDATION_INVALID_REQUEST', { message: 'models probe 需要名称或版本 ID。' });
    return withProject(flags, async (ctx) => ({ data: await probeModels(ctx, ref) }));
  }
  if (action === 'credential') {
    if (rest[0] !== 'set') throw createError('VALIDATION_INVALID_REQUEST', { message: '用法: models credential set。' });
    let key = flags.key;
    if (!key && flags['from-env']) {
      key = process.env[flags['from-env']];
      if (!key) throw createError('VALIDATION_INVALID_REQUEST', { message: `环境变量 ${flags['from-env']} 为空。` });
    }
    if (!key) throw createError('VALIDATION_INVALID_REQUEST', { message: 'models credential set 需要 --key 或 --from-env <VAR>。' });
    return {
      data: storeKeychainCredential({ key, account: flags.account ?? flags.name }),
      warnings: flags.key
        ? [{ code: 'SECRET_IN_ARGV', message: '通过 --key 传入的密钥会留在 shell 历史中，建议改用 --from-env。' }]
        : [],
    };
  }
  if (action === 'from-library') {
    const libraryId = rest[0] ?? flags['library-id'];
    if (!libraryId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'models from-library 需要模型库条目 ID。' });
    const home = flags.home ? resolve(flags.home) : defaultHome();
    return withProject(flags, (ctx) => ({ data: importModelLibraryEntry(ctx, home, libraryId, { name: flags.name }) }));
  }
  throw createError('VALIDATION_INVALID_REQUEST', { message: `未知 models 子命令: ${action}` });
}

function modelLibraryCommand(action, rest, flags) {
  const home = flags.home ? resolve(flags.home) : defaultHome();
  if (action === 'list') return { data: readModelLibrary(home) };
  if (action === 'save') {
    let input = flags.file ? parseJsonOrYamlFile(flags.file) : {};
    if (!flags.file || flags.name) {
      input = {
        ...input,
        ...(flags.name ? { name: flags.name } : {}),
        ...(flags.provider ? { providerType: flags.provider } : {}),
        ...(flags['model-id'] ? { modelId: flags['model-id'] } : {}),
        ...(flags['base-url'] ? { baseUrl: flags['base-url'] } : {}),
        ...(flags.credential ? { credentialRef: flags.credential } : {}),
        ...(flags.params ? { params: JSON.parse(flags.params) } : {}),
        ...(flags.pricing ? { pricing: JSON.parse(flags.pricing) } : {}),
      };
    }
    return { data: saveModelLibraryEntry(home, input) };
  }
  if (action === 'delete') {
    const id = rest[0] ?? flags['library-id'];
    if (!id) throw createError('VALIDATION_INVALID_REQUEST', { message: 'model-library delete 需要条目 ID。' });
    return { data: deleteModelLibraryEntry(home, id) };
  }
  throw createError('VALIDATION_INVALID_REQUEST', { message: `未知 model-library 子命令: ${action}` });
}

function evalProfileCommand(action, rest, flags) {
  if (action === 'create') {
    const template = flags.template === 'default' ? 'default' : null;
    if (!flags.file && !template) throw createError('VALIDATION_INVALID_REQUEST', { message: 'eval-profiles create 需要 --file 或 --template default。' });
    const config = flags.file ? parseJsonOrYamlFile(flags.file) : null;
    const name = flags.name ?? config?.name;
    if (!name) throw createError('VALIDATION_INVALID_REQUEST', { message: 'eval-profiles create 需要 --name。' });
    return withProject(flags, (ctx) => ({ data: createEvaluationProfile(ctx, { name, config, template }) }));
  }
  if (action === 'list') return withProject(flags, (ctx) => ({ data: { profiles: listEvaluationProfiles(ctx) } }));
  if (action === 'show') {
    const ref = rest[0];
    if (!ref) throw createError('VALIDATION_INVALID_REQUEST', { message: 'eval-profiles show 需要名称或版本 ID。' });
    return withProject(flags, (ctx) => {
      const version = ref.startsWith('01') ? getEvaluationProfileVersion(ctx, ref) : findEvaluationProfileByName(ctx, ref);
      return { data: version };
    });
  }
  throw createError('VALIDATION_INVALID_REQUEST', { message: `未知 eval-profiles 子命令: ${action}` });
}

function requireSpec(flags) {
  if (!flags.spec) throw createError('VALIDATION_INVALID_REQUEST', { message: '该命令需要 --spec。' });
  return loadSpecFile(flags.spec);
}

function requireProjectPath(flags) {
  const ctx = openProject(flags.project ?? '.');
  const root = ctx.root;
  ctx.close();
  return root;
}

async function runCommand(action, rest, flags) {
  if (action === 'preflight') {
    const spec = requireSpec(flags);
    return withProject(flags, (ctx) => {
      const plan = preflight(ctx, spec);
      return {
        data: {
          snapshotHash: plan.snapshotHash,
          trialCount: plan.trialCount,
          plan: plan.plan,
          estimate: plan.estimate,
          warnings: plan.warnings,
          risks: plan.risks,
          snapshot: flags.outputs ? plan.snapshot : undefined,
        },
      };
    });
  }
  if (action === 'start') {
    const spec = requireSpec(flags);
    if (flags['dry-run']) {
      return withProject(flags, (ctx) => {
        const plan = preflight(ctx, spec);
        return { data: { dryRun: true, snapshotHash: plan.snapshotHash, trialCount: plan.trialCount, plan: plan.plan, estimate: plan.estimate, warnings: plan.warnings }, warnings: plan.warnings };
      });
    }
    const created = await withProject(flags, (ctx) => createRun(ctx, spec, { idempotencyKey: flags['idempotency-key'] }));
    if (flags.foreground) {
      const root = requireProjectPath(flags);
      const ctx = openProject(root);
      try {
        const executed = await executeRun(ctx, created.runId);
        const artifacts = finalizeRunArtifacts(ctx, created.runId);
        return { data: { ...created, ...executed, artifacts }, warnings: created.warnings };
      } finally {
        ctx.close();
      }
    }
    const root = requireProjectPath(flags);
    spawnWorker(root, created.runId);
    return { data: { ...created, status: 'queued', detached: true }, warnings: created.warnings };
  }
  if (action === 'worker') {
    const runId = rest[0];
    if (!runId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'run worker 需要 runId。' });
    const ctx = openProject(flags.project ?? '.');
    try {
      const result = await executeRun(ctx, runId);
      const artifacts = finalizeRunArtifacts(ctx, runId);
      return { data: { ...result, artifacts }, quiet: true };
    } finally {
      ctx.close();
    }
  }
  if (action === 'status' || action === 'get') {
    const runId = rest[0];
    if (!runId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'run status 需要 runId。' });
    return withProject(flags, (ctx) => ({ data: getRun(ctx, runId, { includeOutputs: Boolean(flags.outputs) }) }));
  }
  if (action === 'wait') {
    const runId = rest[0];
    if (!runId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'run wait 需要 runId。' });
    const timeoutMs = flags.timeout ? parseDuration(flags.timeout) : 600_000;
    if (timeoutMs == null) throw createError('VALIDATION_INVALID_REQUEST', { message: `无法解析 --timeout: ${flags.timeout}` });
    const ctx = openProject(flags.project ?? '.');
    try {
      const waited = await waitRun(ctx, runId, { timeoutMs });
      if (waited.timedOut) {
        const run = getRun(ctx, runId);
        throw createError('INTEGRATION_CLI_TIMEOUT', {
          message: `等待超时，运行仍为 ${waited.status}。`,
          details: { runId, status: waited.status, counts: run.counts },
        });
      }
      return { data: { ...getRun(ctx, runId), waited: true } };
    } finally {
      ctx.close();
    }
  }
  if (action === 'stop' || action === 'cancel') {
    const runId = rest[0];
    if (!runId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'run stop 需要 runId。' });
    return withProject(flags, (ctx) => ({ data: cancelRun(ctx, runId, { modelConfigVersionId: flags.model ?? null }) }));
  }
  if (action === 'list') {
    return withProject(flags, (ctx) => ({
      data: listRuns(ctx, {
        status: flags.status ?? null,
        from: flags.from ?? null,
        to: flags.to ?? null,
        modelConfigVersionId: flags.model ?? null,
        limit: flags.limit ? Number(flags.limit) : 20,
        offset: flags.offset ? Number(flags.offset) : 0,
      }),
    }));
  }
  if (action === 'retry-failed') {
    const runId = rest[0];
    if (!runId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'run retry-failed 需要 runId。' });
    const created = await withProject(flags, (ctx) => deriveRetryRun(ctx, runId));
    if (flags.foreground) {
      const ctx = openProject(flags.project ?? '.');
      try {
        const executed = await executeRun(ctx, created.runId);
        const artifacts = finalizeRunArtifacts(ctx, created.runId);
        return { data: { ...created, ...executed, artifacts } };
      } finally {
        ctx.close();
      }
    }
    const root = requireProjectPath(flags);
    spawnWorker(root, created.runId);
    return { data: { ...created, detached: true } };
  }
  if (action === 'events') {
    const runId = rest[0];
    if (!runId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'run events 需要 runId。' });
    return withProject(flags, (ctx) => {
      const data = getRun(ctx, runId, { includeOutputs: true });
      const after = Number(flags.after ?? 0);
      return { data: { runId, events: data.events.filter((event) => event.seq > after) } };
    });
  }
  throw createError('VALIDATION_INVALID_REQUEST', { message: `未知 run 子命令: ${action}` });
}

function reportCommand(action, rest, flags) {
  if (action === 'generate') {
    const runId = rest[0];
    if (!runId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'report generate 需要 runId。' });
    let template = DEFAULT_TEMPLATE;
    if (flags['template-file']) template = parseJsonOrYamlFile(flags['template-file']);
    else if (flags.template && flags.template !== 'standard') {
      throw createError('VALIDATION_REPORT_TEMPLATE_INVALID', { message: `未知内置模板: ${flags.template}（仅 standard）` });
    }
    if (flags['template-file']) validateTemplate(template);
    return withProject(flags, (ctx) => ({ data: generateReport(ctx, runId, { template }) }));
  }
  if (action === 'list') {
    return withProject(flags, (ctx) => ({ data: { reports: listReports(ctx, flags.run ?? rest[0] ?? null) } }));
  }
  if (action === 'show') {
    const reportId = rest[0];
    if (!reportId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'report show 需要 reportId。' });
    return withProject(flags, (ctx) => {
      const { report, markdown } = getReport(ctx, reportId);
      if (!flags.json && markdown) {
        return { data: { report }, stdout: markdown };
      }
      return { data: { report, markdown } };
    });
  }
  if (action === 'export') {
    const reportId = rest[0];
    if (!reportId) throw createError('VALIDATION_INVALID_REQUEST', { message: 'report export 需要 reportId。' });
    if (!flags.path) throw createError('VALIDATION_INVALID_REQUEST', { message: 'report export 需要 --path。' });
    return withProject(flags, (ctx) => ({ data: exportReport(ctx, reportId, flags.path) }));
  }
  throw createError('VALIDATION_INVALID_REQUEST', { message: `未知 report 子命令: ${action}` });
}

async function serveCommand(flags) {
  const { startServer } = await import('../server/http.js');
  const port = flags.port === undefined ? 0 : Number(flags.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: `端口非法: ${flags.port}` });
  }
  const handle = await startServer({
    port,
    host: flags.host ?? '127.0.0.1',
    workspace: flags.workspace ?? process.cwd(),
    tokenFile: flags['token-file'] ?? null,
    home: flags.home ?? null,
    origins: flags.origin ? String(flags.origin).split(',').map((item) => item.trim()).filter(Boolean) : undefined,
  });
  process.stdout.write(
    `${JSON.stringify({ event: 'ready', endpoint: handle.endpoint, tokenFile: handle.tokenFile, pid: process.pid })}\n`,
  );
  const shutdown = () => {
    handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { data: { served: true, endpoint: handle.endpoint, tokenFile: handle.tokenFile }, quiet: true };
}

async function mcpCommand(action, rest, flags) {
  if (action === 'info') {
    const root = flags.project ? resolve(flags.project) : resolve('.');
    const scopes = flags.scopes
      ? String(flags.scopes).split(',').map((scope) => scope.trim()).filter(Boolean)
      : undefined;
    return { data: mcpInfo({ projectRoot: root, scopes }) };
  }
  if (action !== 'serve') throw createError('VALIDATION_INVALID_REQUEST', { message: `未知 mcp 子命令: ${action}` });
  const { startMcpServer } = await import('../mcp/server.js');
  const root = flags.project ? resolve(flags.project) : resolve('.');
  await startMcpServer({
    projectRoot: root,
    scopes: (flags.scopes ?? 'project:read,run:read,run:write').split(',').map((scope) => scope.trim()).filter(Boolean),
  });
  return { data: { served: true }, quiet: true };
}

function capabilitiesCommand() {
  return {
    data: {
      apiVersion: API_VERSION,
      serverVersion: SERVER_VERSION,
      mcp: {
        defaultProtocolVersion: MCP_DEFAULT_PROTOCOL_VERSION,
        supportedProtocolVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
        transports: ['stdio'],
      },
      exitCodes: [0, 2, 3, 4, 5, 6, 7, 10, 11, 12, 124, 130],
      errorCodes: catalogSummary(),
      commands: [
        'project create|list|open|health|rename|archive|settings|backup|recover|recovery-list|locate|delete|import|restore-backup|trash|restore',
        'prompts import|list|show|diff|add|iterate',
        'cases import|generate|list',
        'testsets list|show|find',
        'library list|show|promote|import',
        'models add|list|show|test|probe|credential|from-library',
        'model-library list|save|delete',
        'eval-profiles create|list|show',
        'run preflight|start|status|wait|list|stop|retry-failed|events',
        'report generate|list|show|export',
        'mcp info|serve',
        'serve',
        'capabilities',
      ],
      limits: {
        maxVariants: 20,
        maxModels: 32,
        maxRepetitions: 20,
        maxAttempts: 10,
        maxConcurrency: 256,
        maxFallbacksPerModel: 5,
      },
    },
  };
}

function spawnWorker(root, runId) {
  return spawnRunWorker(root, runId);
}

function parseJsonOrYamlFile(path) {
  if (!existsSync(path)) throw createError('VALIDATION_INVALID_REQUEST', { message: `文件不存在: ${path}` });
  const text = readFileSync(path, 'utf8');
  if (path.endsWith('.json')) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw createError('VALIDATION_INVALID_REQUEST', { message: `JSON 解析失败: ${error.message}` });
    }
  }
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return parseYaml(text);
  throw createError('VALIDATION_UNSUPPORTED_FORMAT', { message: `仅支持 .json / .yaml / .yml: ${path}` });
}

function writeOutput(envelope, flags, stdout) {
  if (flags.output && envelope.ok) {
    const content = stdout ?? (typeof envelope.data === 'string' ? envelope.data : `${JSON.stringify(envelope.data, null, 2)}\n`);
    mkdirSync(join(flags.output, '..'), { recursive: true });
    writeFileSync(flags.output, content, 'utf8');
  }
  if (stdout !== undefined && !flags.json && !flags.quiet) {
    process.stdout.write(stdout);
    return;
  }
  if (flags.quiet) return;
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }
  if (envelope.ok) {
    process.stdout.write(`${renderHuman(envelope.data)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  }
}

function renderHuman(data) {
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data;
  if (data.runId && data.status && data.trialCount !== undefined) {
    return `runId: ${data.runId}\nstatus: ${data.status}\ntrialCount: ${data.trialCount}`;
  }
  if (data.reportId) return `reportId: ${data.reportId}\npath: ${data.path ?? ''}`;
  if (data.projectId && data.name) return `projectId: ${data.projectId}\nname: ${data.name}\nroot: ${data.root}`;
  return JSON.stringify(data, null, 2);
}

function presentHelp(flags) {
  const text = `PromptLens CLI ${SERVER_VERSION}

用法: promptlens <命令组> <子命令> [参数] [--json]

命令组:
  project        create | list | open | health | rename | archive | settings | backup | recover | recovery-list | locate | delete | import | restore-backup | trash | restore
  prompts        import | list | show | diff | add | restore | iterate | suggest | suggest-context | suggestions | suggestion-status
  cases          import | generate | list
  testsets       list | show | find
  library        list | show | promote | import
  models         add | list | show | test | probe | credential | from-library
  model-library  list | save | delete
  eval-profiles  create | list | show
  run            preflight | start | status | wait | list | stop | retry-failed | events
  report         generate | list | show | export
  mcp            info | serve
  serve          启动本地 UI API（环回 + 一次性令牌）
  capabilities

全局选项:
  --project <path>         项目根目录
  --json                   机器可读结果信封
  --no-input               禁止交互
  --dry-run                仅校验/预览
  --idempotency-key <key>  写操作幂等键
  --timeout <duration>     超时，如 30m
  --outputs                附带逐 Trial 输出
  --help                   显示帮助

密钥: models credential set 优先使用 --from-env <VAR> 读取密钥；--key 会留在 shell 历史中。
`;
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(success({ help: text }))}\n`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}
