import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createError } from './errors.js';
import { MANIFEST_NAME, openProject, projectSummary } from './project.js';
import { parseYaml, stringifyYaml } from './yaml.js';
import { nowIso } from './time.js';
import { setMeta } from './db.js';
import { recordAudit } from './audit.js';
import { SERVER_VERSION } from '../version.js';

export const BACKUP_METADATA_NAME = 'promptlens.backup.json';
export const RECOVERY_MANIFEST_NAME = 'promptlens.recovery.json';
export const DEFAULT_PROJECT_SETTINGS = Object.freeze({ autoReport: true, autoExport: true, sensitiveFields: [] });

/** 备份/导入/恢复只处理 PromptLens 自己的资产，避免把用户仓库里的无关文件一起搬运。 */
const PORTABLE_ENTRIES = [MANIFEST_NAME, 'README.promptlens.md'];
const PORTABLE_DIRECTORIES = [
  { from: '.promptlens', to: '.promptlens', exclude: ['cache'] },
  { from: join('exports', 'reports'), to: join('exports', 'reports') },
  { from: join('exports', 'prompts'), to: join('exports', 'prompts') },
  { from: join('exports', 'cases'), to: join('exports', 'cases') },
];

export function readManifest(ctx) {
  const path = join(ctx.root, MANIFEST_NAME);
  return parseYaml(readFileSync(path, 'utf8'));
}

function writeManifest(ctx, manifest) {
  const path = join(ctx.root, MANIFEST_NAME);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${stringifyYaml(manifest)}\n`, { encoding: 'utf8', mode: 0o644 });
  try {
    renameSync(tmp, path);
  } catch {
    // Windows 下 rename 不能覆盖已存在文件
    rmSync(path, { force: true });
    renameSync(tmp, path);
  }
  ctx.manifest = manifest;
}

export function projectSettings(ctx) {
  const stored = readManifest(ctx).settings ?? {};
  return {
    ...DEFAULT_PROJECT_SETTINGS,
    ...stored,
    sensitiveFields: Array.isArray(stored.sensitiveFields) ? stored.sensitiveFields : [],
  };
}

export function updateProjectSettings(ctx, patch = {}) {
  const next = { ...projectSettings(ctx) };
  for (const key of ['autoReport', 'autoExport']) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== 'boolean') {
      throw createError('VALIDATION_INVALID_REQUEST', { message: `项目设置 ${key} 必须是布尔值。` });
    }
    next[key] = patch[key];
  }
  if (patch.sensitiveFields !== undefined) {
    if (!Array.isArray(patch.sensitiveFields)) {
      throw createError('VALIDATION_INVALID_REQUEST', { message: '项目设置 sensitiveFields 必须是字符串数组。' });
    }
    next.sensitiveFields = patch.sensitiveFields.map((item) => String(item ?? '').trim()).filter(Boolean);
    for (const item of next.sensitiveFields) {
      if (!item.startsWith('regex:')) continue;
      try {
        new RegExp(item.slice('regex:'.length));
      } catch (error) {
        throw createError('VALIDATION_INVALID_REQUEST', { message: `敏感字段正则非法: ${item}（${error.message}）` });
      }
    }
  }
  const manifest = readManifest(ctx);
  manifest.settings = next;
  writeManifest(ctx, manifest);
  // 审计只记录字段数量，避免把敏感值写进审计日志
  recordAudit(ctx, 'project.settings_updated', {
    settings: { ...next, sensitiveFields: `${next.sensitiveFields.length} 条已隐藏` },
  });
  return next;
}

export function renameProject(ctx, name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw createError('VALIDATION_INVALID_REQUEST', { message: '项目名称不能为空。' });
  const manifest = readManifest(ctx);
  const previous = manifest.name;
  manifest.name = trimmed;
  writeManifest(ctx, manifest);
  setMeta(ctx.db, 'projectName', trimmed);
  recordAudit(ctx, 'project.renamed', { from: previous, to: trimmed });
  return { ...projectSummary({ ...ctx, manifest }), previousName: previous };
}

export function setProjectArchived(ctx, archived) {
  const manifest = readManifest(ctx);
  const next = { ...manifest };
  if (archived) {
    if (!next.archivedAt) next.archivedAt = nowIso();
  } else {
    delete next.archivedAt;
  }
  writeManifest(ctx, next);
  recordAudit(ctx, archived ? 'project.archived' : 'project.unarchived', { projectId: next.projectId });
  return { ...projectSummary({ ...ctx, manifest: next }), archivedAt: next.archivedAt ?? null };
}

/**
 * 生成便携备份：只包含清单、`.promptlens`（排除缓存）与导出目录。
 * 目标默认放在应用数据目录 `backups/`，避免写回项目自身造成递归。
 */
export function backupProject(ctx, { home = defaultHome(), destination = null } = {}) {
  const stamp = timestamp();
  const target = resolve(destination ?? join(home, 'backups', `${ctx.projectId}-${stamp}`));
  if (isInside(target, ctx.root) && relative(ctx.root, target).startsWith('exports')) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: '备份目录不能位于项目的 exports 目录内。' });
  }
  if (existsSync(target) && readdirSync(target).length) {
    throw createError('STATE_INVALID_TRANSITION', { message: `备份目标已存在且非空: ${target}` });
  }
  // WAL 中的事务先合并进主库，避免备份到尚未落盘的数据
  try {
    ctx.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  } catch {
    /* 只读或已关闭时忽略 */
  }
  mkdirSync(target, { recursive: true });
  const copied = copyPortableAssets(ctx.root, target);
  const databaseHash = sha256File(join(ctx.root, '.promptlens', 'db', 'project.sqlite3'));
  const metadata = {
    schema: 'promptlens.backup/v1',
    projectId: ctx.projectId,
    name: ctx.manifest.name,
    projectCreatedAt: ctx.manifest.createdAt,
    backupAt: nowIso(),
    appVersion: SERVER_VERSION,
    databaseHash,
    counts: projectSummary(ctx).counts,
    files: copied.files,
    bytes: copied.bytes,
  };
  writeFileSync(join(target, BACKUP_METADATA_NAME), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  recordAudit(ctx, 'project.backed_up', { path: target, files: copied.files, bytes: copied.bytes, databaseHash });
  return { ...metadata, path: target };
}

/** 从项目目录或备份目录导入到新目录；目标已有 PromptLens 清单时拒绝覆盖。 */
export function importProject({ source, destination }) {
  const from = resolve(source);
  const to = resolve(destination);
  const sourceManifest = join(from, MANIFEST_NAME);
  if (!existsSync(sourceManifest)) {
    throw createError('NOT_FOUND_PROJECT', { message: `来源目录不是 PromptLens 项目: ${from}` });
  }
  if (!existsSync(join(from, '.promptlens', 'db', 'project.sqlite3'))) {
    throw createError('STORAGE_DB_CORRUPTED', { message: '来源项目缺少数据库，无法导入。', details: { path: from } });
  }
  if (existsSync(join(to, MANIFEST_NAME))) {
    throw createError('STATE_INVALID_TRANSITION', {
      message: `目标目录已存在 PromptLens 项目，已阻止覆盖: ${to}`,
      details: { path: to },
    });
  }
  // 来源项目可能仍被服务端打开，先把 WAL 合并进主库，避免复制时丢事务
  checkpointDatabase(join(from, '.promptlens', 'db', 'project.sqlite3'));
  mkdirSync(to, { recursive: true });
  const copied = copyPortableAssets(from, to);
  const ctx = openProject(to);
  try {
    recordAudit(ctx, 'project.imported', { from, to, files: copied.files, bytes: copied.bytes });
    return { ...projectSummary(ctx), importedFrom: from, files: copied.files, bytes: copied.bytes };
  } finally {
    ctx.close();
  }
}

export function restoreBackup({ backup, destination }) {
  const from = resolve(backup);
  const metadataPath = join(from, BACKUP_METADATA_NAME);
  if (!existsSync(metadataPath)) {
    throw createError('NOT_FOUND_PROJECT', { message: `目标不是 PromptLens 备份: ${from}` });
  }
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  if (metadata.schema !== 'promptlens.backup/v1') {
    throw createError('VALIDATION_SCHEMA_INVALID', { message: `不支持的备份版本: ${metadata.schema}`, scope: 'backup' });
  }
  const result = importProject({ source: from, destination });
  return { ...result, backup: metadata };
}

/**
 * 只读枚举项目可恢复对象：数据库以只读方式打开，任何写入都被禁止。
 * 数据库缺失或损坏时返回 database=missing/unreadable，而不是抛错，便于在恢复界面向用户展示。
 */
export function listRecoverableObjects(root) {
  const projectRoot = resolve(root);
  const dbPath = join(projectRoot, '.promptlens', 'db', 'project.sqlite3');
  if (!existsSync(dbPath)) {
    return { database: 'missing', error: null, counts: null, prompts: [], testSets: [], runs: [], reports: [] };
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000;');
    const count = (sql) => Number(db.prepare(sql).get().n ?? 0);
    const counts = {
      prompts: count('SELECT COUNT(*) AS n FROM prompts'),
      promptVersions: count('SELECT COUNT(*) AS n FROM prompt_versions'),
      cases: count('SELECT COUNT(*) AS n FROM cases'),
      models: count('SELECT COUNT(*) AS n FROM model_config_versions'),
      runs: count('SELECT COUNT(*) AS n FROM runs'),
      reports: count('SELECT COUNT(*) AS n FROM reports'),
    };
    const prompts = db
      .prepare(
        `SELECT p.id, p.name, COUNT(pv.id) AS versions
         FROM prompts p
         LEFT JOIN prompt_variants v ON v.prompt_id = p.id
         LEFT JOIN prompt_versions pv ON pv.variant_id = v.id
         GROUP BY p.id ORDER BY p.created_at`,
      )
      .all();
    const testSets = db.prepare('SELECT id, name FROM test_sets ORDER BY created_at').all();
    const runs = db.prepare('SELECT id, status, snapshot_hash FROM runs ORDER BY created_at DESC LIMIT 50').all();
    const reports = db.prepare('SELECT id, run_id, status FROM reports ORDER BY generated_at DESC LIMIT 50').all();
    return { database: 'readable', error: null, counts, prompts, testSets, runs, reports };
  } catch (error) {
    return { database: 'unreadable', error: error.message, counts: null, prompts: [], testSets: [], runs: [], reports: [] };
  } finally {
    try {
      db?.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/**
 * 生成恢复副本：先复制项目资产，再写入只读恢复清单（0o444），
 * 清单列举仍可恢复的提示词、测试集、运行与报告，供只读界面展示。
 */
export function createRecoveryCopy({ root, home = defaultHome(), destination = null } = {}) {
  const projectRoot = resolve(root);
  const manifestPath = join(projectRoot, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw createError('NOT_FOUND_PROJECT', { message: `未找到项目清单: ${manifestPath}` });
  }
  const manifest = parseYaml(readFileSync(manifestPath, 'utf8'));
  const target = resolve(destination ?? join(home, 'recovery', `${manifest.projectId}-${timestamp()}`));
  if (isInside(target, projectRoot)) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: '恢复副本不能写入项目目录内部。' });
  }
  if (existsSync(target) && readdirSync(target).length) {
    throw createError('STATE_INVALID_TRANSITION', { message: `恢复副本目标已存在且非空: ${target}` });
  }
  mkdirSync(target, { recursive: true });
  const copied = copyPortableAssets(projectRoot, target);
  const objects = listRecoverableObjects(projectRoot);
  const recovery = {
    schema: 'promptlens.recovery/v1',
    projectId: manifest.projectId,
    name: manifest.name,
    sourcePath: projectRoot,
    recoveryAt: nowIso(),
    appVersion: SERVER_VERSION,
    readonly: true,
    databaseStatus: objects.database,
    objects,
    files: copied.files,
    bytes: copied.bytes,
  };
  const recoveryManifestPath = join(target, RECOVERY_MANIFEST_NAME);
  writeFileSync(recoveryManifestPath, `${JSON.stringify(recovery, null, 2)}\n`, { encoding: 'utf8', mode: 0o444 });
  return { ...recovery, path: target, manifestPath: recoveryManifestPath };
}

export function getRecoveryCopy(recoveryPath) {
  const from = resolve(recoveryPath);
  const manifestPath = join(from, RECOVERY_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw createError('NOT_FOUND_PROJECT', { message: `目标不是 PromptLens 恢复副本: ${from}` });
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 'promptlens.recovery/v1') {
    throw createError('VALIDATION_SCHEMA_INVALID', { message: `不支持的恢复清单版本: ${manifest.schema}`, scope: 'recovery' });
  }
  return { ...manifest, path: from, manifestPath };
}

export function listRecoveryCopies(home = defaultHome()) {
  const dir = join(home, 'recovery');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(getRecoveryCopy(join(dir, entry.name)));
    } catch {
      /* 跳过非恢复副本目录 */
    }
  }
  return out.sort((a, b) => String(b.recoveryAt).localeCompare(String(a.recoveryAt)));
}

/** 目录移动后按 projectId 在给定目录树中定位项目根，不依赖历史注册表路径。 */
export function locateProjectRoot({ projectId, searchRoots = [process.cwd()], maxDepth = 4 } = {}) {
  const wanted = String(projectId ?? '').trim();
  if (!wanted) throw createError('VALIDATION_INVALID_REQUEST', { message: '定位项目需要 projectId。' });
  const roots = searchRoots.map((root) => resolve(root));
  for (const start of roots) {
    const found = scanForProject(start, wanted, maxDepth);
    if (found) return found;
  }
  throw createError('NOT_FOUND_PROJECT', {
    message: `未在指定目录中找到项目 ${wanted}`,
    details: { projectId: wanted, searchRoots: roots },
  });
}

function scanForProject(dir, projectId, depth) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  if (entries.some((entry) => entry.isFile() && entry.name === MANIFEST_NAME)) {
    try {
      const manifest = parseYaml(readFileSync(join(dir, MANIFEST_NAME), 'utf8'));
      if (manifest.projectId === projectId) return { projectId, root: dir, name: manifest.name };
    } catch {
      /* 清单损坏则跳过 */
    }
    return null;
  }
  if (depth <= 0) return null;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const found = scanForProject(join(dir, entry.name), projectId, depth - 1);
    if (found) return found;
  }
  return null;
}

/** 定位后写回最近项目索引，避免注册表继续指向旧路径。 */
export function updateRecentProject(home = defaultHome(), { projectId, path, root, name }) {
  const projectPath = path ?? root;
  const dir = resolve(home);
  mkdirSync(dir, { recursive: true });
  const recentPath = join(dir, 'recent-projects.json');
  let projects = [];
  try {
    const parsed = JSON.parse(readFileSync(recentPath, 'utf8'));
    if (Array.isArray(parsed.projects)) projects = parsed.projects;
  } catch {
    /* 首次写入 */
  }
  projects = [
    { projectId, path: projectPath, name, lastOpenedAt: nowIso() },
    ...projects.filter((item) => item && item.projectId !== projectId),
  ].slice(0, 20);
  const tmp = `${recentPath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, recentPath);
  return { projectId, path: projectPath, name };
}

/**
 * 删除项目：默认移动应用数据目录 `trash/`（可恢复）；永久删除必须显式传入 projectId 作为确认。
 * 调用方需要先关闭项目数据库连接。
 */
export function deleteProject({ root, home = defaultHome(), permanent = false, confirmProjectId = null }) {
  const projectRoot = resolve(root);
  const manifestPath = join(projectRoot, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw createError('NOT_FOUND_PROJECT', { message: `未找到项目清单: ${manifestPath}` });
  }
  const manifest = parseYaml(readFileSync(manifestPath, 'utf8'));
  if (permanent) {
    if (confirmProjectId !== manifest.projectId) {
      throw createError('VALIDATION_INVALID_REQUEST', {
        message: '永久删除需要通过 --confirm-project-id 传入完整项目 ID。',
        details: { projectId: manifest.projectId },
      });
    }
    rmSync(projectRoot, { recursive: true, force: false });
    return { projectId: manifest.projectId, name: manifest.name, path: projectRoot, permanent: true, recoverable: false };
  }
  const target = join(home, 'trash', `${manifest.projectId}-${timestamp()}`);
  mkdirSync(dirname(target), { recursive: true });
  try {
    renameSync(projectRoot, target);
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error;
    cpSync(projectRoot, target, { recursive: true });
    rmSync(projectRoot, { recursive: true, force: false });
  }
  const entry = {
    projectId: manifest.projectId,
    name: manifest.name,
    originalPath: projectRoot,
    trashedAt: nowIso(),
    trashPath: target,
  };
  appendTrashIndex(home, entry);
  return { projectId: manifest.projectId, name: manifest.name, path: target, permanent: false, recoverable: true, trashedAt: entry.trashedAt };
}

export function listTrash(home = defaultHome()) {
  const path = join(home, 'trash', 'index.json');
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

/** 从回收站恢复到原路径；原路径被占用时拒绝，避免覆盖现有目录。 */
export function restoreTrash(home, projectId) {
  const entries = listTrash(home);
  const entry = entries.find((item) => item.projectId === projectId);
  if (!entry) throw createError('NOT_FOUND_PROJECT', { message: `回收站中没有项目 ${projectId}` });
  if (!existsSync(entry.trashPath)) {
    throw createError('NOT_FOUND_PROJECT', { message: `回收站目录已不存在: ${entry.trashPath}` });
  }
  if (existsSync(entry.originalPath)) {
    throw createError('STATE_INVALID_TRANSITION', { message: `原路径已被占用，无法恢复: ${entry.originalPath}` });
  }
  mkdirSync(dirname(entry.originalPath), { recursive: true });
  try {
    renameSync(entry.trashPath, entry.originalPath);
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error;
    cpSync(entry.trashPath, entry.originalPath, { recursive: true });
    rmSync(entry.trashPath, { recursive: true, force: false });
  }
  const next = entries.filter((item) => item.projectId !== projectId);
  const path = join(home, 'trash', 'index.json');
  writeFileSync(path, `${JSON.stringify({ version: 1, entries: next }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { projectId, restoredTo: entry.originalPath, name: entry.name };
}

export function defaultHome() {
  return resolve(process.env.PROMPTLENS_HOME ?? join(homedir(), '.promptlens'));
}

function copyPortableAssets(source, target) {
  let files = 0;
  let bytes = 0;
  const copyFile = (from, to) => {
    if (!existsSync(from)) return;
    cpSync(from, to, { recursive: false });
    files += 1;
    bytes += statSync(to).size;
  };
  for (const entry of PORTABLE_ENTRIES) {
    copyFile(join(source, entry), join(target, entry));
  }
  for (const entry of PORTABLE_DIRECTORIES) {
    const from = join(source, entry.from);
    if (!existsSync(from)) continue;
    const to = join(target, entry.to);
    cpSync(from, to, {
      recursive: true,
      filter: (src) => {
        const rel = relative(from, src).split('\\').join('/');
        if (rel.split('/').some((part) => entry.exclude?.includes(part))) return false;
        // 备份前已 checkpoint；WAL/SHM 在复制期间可能重建或消失，跳过避免竞态
        if (rel.endsWith('-wal') || rel.endsWith('-shm')) return false;
        return true;
      },
    });
    for (const file of walk(from)) {
      const rel = relative(from, file).split('\\').join('/');
      if (rel.split('/').some((part) => entry.exclude?.includes(part))) continue;
      if (rel.endsWith('-wal') || rel.endsWith('-shm')) continue;
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      files += 1;
      bytes += size;
    }
  }
  return { files, bytes };
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function checkpointDatabase(path) {
  if (!existsSync(path)) return;
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  } catch {
    /* 数据库被占用或只读时保留原样，复制仍会带上已提交内容 */
  } finally {
    try {
      db?.close();
    } catch {
      /* 已关闭 */
    }
  }
}

function sha256File(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function appendTrashIndex(home, entry) {
  const dir = join(home, 'trash');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'index.json');
  const entries = listTrash(home).filter((item) => item.projectId !== entry.projectId);
  entries.unshift(entry);
  writeFileSync(path, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel && !rel.startsWith('..') && !rel.startsWith('/');
}

function timestamp() {
  return nowIso().replace(/[:.]/g, '-');
}
