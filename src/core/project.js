import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseYaml, stringifyYaml } from './yaml.js';
import { createError } from './errors.js';
import { ulid } from './ids.js';
import { nowIso } from './time.js';
import { openDatabase, getMeta, setMeta, integrityCheck } from './db.js';
import { readProjectLock } from './lock.js';
import { SERVER_VERSION } from '../version.js';

export const MANIFEST_NAME = 'promptlens.project.yaml';
const MANIFEST_SCHEMA = 'promptlens.project/v1';

export function findProjectRoot(start = process.cwd()) {
  let current = resolve(start);
  for (let depth = 0; depth < 40; depth++) {
    if (existsSync(join(current, MANIFEST_NAME))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function createProject(options) {
  const root = resolve(options.path);
  const name = String(options.name ?? '').trim();
  if (!name) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: '创建项目需要非空名称。' });
  }
  if (existsSync(join(root, MANIFEST_NAME))) {
    throw createError('STATE_INVALID_TRANSITION', { message: '目标目录已存在 PromptLens 项目。', details: { path: root } });
  }
  const projectId = options.projectId ?? ulid();
  const createdAt = nowIso();
  const manifest = {
    schema: MANIFEST_SCHEMA,
    projectId,
    name,
    createdAt,
    createdBy: `promptlens/${SERVER_VERSION}`,
    dataDirectory: '.promptlens',
    minimumReaderVersion: SERVER_VERSION,
  };

  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, '.promptlens', 'db'), { recursive: true });
  for (const dir of ['objects', 'events', 'recovery', 'cache']) {
    mkdirSync(join(root, '.promptlens', dir), { recursive: true });
  }
  for (const dir of ['prompts', 'cases', 'reports']) {
    mkdirSync(join(root, 'exports', dir), { recursive: true });
  }
  writeFileSync(join(root, MANIFEST_NAME), `${stringifyYaml(manifest)}\n`, { encoding: 'utf8', flag: 'wx' });
  writeFileSync(join(root, 'README.promptlens.md'), projectReadme(name), 'utf8');

  const db = openDatabase(join(root, '.promptlens', 'db', 'project.sqlite3'));
  try {
    setMeta(db, 'projectId', projectId);
    setMeta(db, 'projectName', name);
    setMeta(db, 'schemaVersion', '1');
    setMeta(db, 'createdAt', createdAt);
  } finally {
    db.close();
  }

  return { root, manifest };
}

export function openProject(ref) {
  const root = resolveProjectRoot(ref);
  const manifestPath = join(root, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw createError('NOT_FOUND_PROJECT', { message: '未找到 PromptLens 项目清单。', remediation: '在项目目录运行 promptlens project create，或用 --project 指向项目根目录。' });
  }
  const manifest = parseYaml(readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw createError('VALIDATION_SCHEMA_INVALID', { message: `不支持的项目清单版本: ${manifest.schema}`, scope: 'project' });
  }
  if (compareVersions(manifest.minimumReaderVersion ?? '0.0.0', SERVER_VERSION) > 0) {
    throw createError('VALIDATION_SCHEMA_INVALID', {
      message: `项目要求 PromptLens >= ${manifest.minimumReaderVersion}，当前为 ${SERVER_VERSION}。`,
      scope: 'project',
    });
  }
  const dbPath = join(root, '.promptlens', 'db', 'project.sqlite3');
  if (!existsSync(dbPath)) {
    throw createError('STORAGE_DB_CORRUPTED', { message: '项目数据库缺失。', details: { path: dbPath } });
  }
  const db = openDatabase(dbPath);
  const ctx = {
    root,
    manifest,
    projectId: manifest.projectId,
    db,
    dbPath,
    close() {
      db.close();
    },
  };
  return ctx;
}

function resolveProjectRoot(ref) {
  if (!ref) {
    const found = findProjectRoot(process.cwd());
    if (found) return found;
    throw createError('NOT_FOUND_PROJECT', { message: '当前目录不是 PromptLens 项目。' });
  }
  const candidate = resolve(String(ref));
  if (existsSync(candidate)) {
    const stat = statSync(candidate);
    if (stat.isDirectory()) return candidate;
    throw createError('NOT_FOUND_PROJECT', { message: `--project 必须是目录: ${ref}` });
  }
  // 允许传入 projectId：只有当前工作目录匹配时才可使用，避免猜测路径
  const found = findProjectRoot(process.cwd());
  if (found) {
    try {
      const manifest = parseYaml(readFileSync(join(found, MANIFEST_NAME), 'utf8'));
      if (manifest.projectId === ref) return found;
    } catch {
      /* 继续报告未找到 */
    }
  }
  throw createError('NOT_FOUND_PROJECT', { message: `无法解析项目引用: ${ref}`, remediation: '传入项目目录路径，或切换到项目目录后重试。' });
}

export function projectHealth(ctx) {
  const checks = [];
  const push = (name, status, details = {}) => checks.push({ name, status, ...details });

  push('manifest', 'ok', { projectId: ctx.manifest.projectId, schema: ctx.manifest.schema });

  const integrity = integrityCheck(ctx.db);
  push('database_integrity', integrity.length === 1 && integrity[0] === 'ok' ? 'ok' : 'error', { result: integrity });

  const objectsDir = join(ctx.root, '.promptlens', 'objects');
  push('object_store', existsSync(objectsDir) ? 'ok' : 'error', { path: '.promptlens/objects' });

  const lock = readProjectLock(ctx.root);
  push('write_lock', lock ? 'degraded' : 'ok', lock ? { holder: lock } : {});

  const counts = countRows(ctx.db);
  push('counts', 'ok', counts);
  const failed = checks.filter((check) => check.status === 'error');
  const degraded = checks.filter((check) => check.status === 'degraded');

  return {
    projectId: ctx.manifest.projectId,
    name: ctx.manifest.name,
    root: ctx.root,
    status: failed.length ? 'error' : degraded.length ? 'degraded' : 'ok',
    checks,
    counts,
    schemaVersion: getMeta(ctx.db, 'schemaVersion'),
  };
}

function countRows(db) {
  const scalar = (sql) => Number(db.prepare(sql).get().n ?? 0);
  return {
    prompts: scalar('SELECT COUNT(*) AS n FROM prompts'),
    promptVersions: scalar('SELECT COUNT(*) AS n FROM prompt_versions'),
    cases: scalar('SELECT COUNT(*) AS n FROM cases'),
    testSets: scalar('SELECT COUNT(*) AS n FROM test_sets'),
    models: scalar('SELECT COUNT(*) AS n FROM model_config_versions'),
    runs: scalar('SELECT COUNT(*) AS n FROM runs'),
    reports: scalar('SELECT COUNT(*) AS n FROM reports'),
  };
}

/** 在目录树中递归发现项目（深度上限 3），跳过隐藏目录与 node_modules。 */
export function discoverProjects(start, { maxDepth = 3 } = {}) {
  const out = [];
  const walk = (dir, depth) => {
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
        /* 损坏项目在健康检查中单独暴露 */
      }
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(resolve(start), 0);
  return out;
}

export function projectSummary(ctx) {
  return {
    projectId: ctx.manifest.projectId,
    name: ctx.manifest.name,
    root: ctx.root,
    createdAt: ctx.manifest.createdAt,
    archivedAt: ctx.manifest.archivedAt ?? null,
    schema: ctx.manifest.schema,
    counts: countRows(ctx.db),
  };
}

export function recordingProjectPath(ctx) {
  return join(ctx.root, '.promptlens', 'db', 'project.sqlite3');
}

function projectReadme(name) {
  return `# ${name}

本目录由 PromptLens 管理。

- \`promptlens.project.yaml\`：项目清单，请用 PromptLens CLI 或界面修改。
- \`.promptlens/\`：项目数据库与不可变内容对象，请勿手工编辑。
- \`exports/reports/\`：按运行归档的 Markdown 报告。

常用命令：

\`\`\`bash
promptlens project health --project . --json
promptlens run start --project . --spec experiment.json --idempotency-key demo-001 --json
promptlens report generate <run-id> --project . --json
\`\`\`
`;
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((part) => Number(part) || 0);
  const pb = String(b).split('.').map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}
