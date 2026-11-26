import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createError } from './errors.js';
import { getTestSetVersion, importCases } from './cases.js';
import { hashJson } from './hash.js';
import { ulid } from './ids.js';
import { nowIso } from './time.js';

const ENTRY_SCHEMA = 'promptlens.library-entry/v1';
const ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

export function defaultHome() {
  return resolve(process.env.PROMPTLENS_HOME ?? join(homedir(), '.promptlens'));
}

/** 用例库是跨项目的本机全局存储，可用 PROMPTLENS_LIBRARY_DIR 覆盖。 */
export function libraryRoot(home = defaultHome()) {
  const override = process.env.PROMPTLENS_LIBRARY_DIR;
  return override ? resolve(override) : join(resolve(home), 'library');
}

function entriesDir(root) {
  return join(root, 'entries');
}

function entryPath(root, libraryId) {
  if (!ID_PATTERN.test(String(libraryId ?? ''))) {
    throw createError('NOT_FOUND_LIBRARY', { message: `非法用例库 ID: ${libraryId}` });
  }
  return join(entriesDir(root), `${libraryId}.json`);
}

function readEntry(root, libraryId) {
  const path = entryPath(root, libraryId);
  if (!existsSync(path)) throw createError('NOT_FOUND_LIBRARY', { message: `用例库快照不存在: ${libraryId}` });
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw createError('STORAGE_DB_CORRUPTED', { message: `用例库快照无法读取: ${error.message}`, details: { libraryId } });
  }
  if (parsed?.schema !== ENTRY_SCHEMA || !Array.isArray(parsed.cases)) {
    throw createError('STORAGE_DB_CORRUPTED', { message: '用例库快照结构无效。', details: { libraryId } });
  }
  return parsed;
}

function readAllEntries(root) {
  const dir = entriesDir(root);
  if (!existsSync(dir)) return [];
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (parsed?.schema === ENTRY_SCHEMA && Array.isArray(parsed.cases)) entries.push(parsed);
    } catch {
      /* 跳过损坏快照，不影响其余条目 */
    }
  }
  return entries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function summaryOf(entry) {
  return {
    libraryId: entry.libraryId,
    setName: entry.setName,
    version: entry.version,
    caseCount: entry.caseCount,
    contentHash: entry.contentHash,
    license: entry.license ?? null,
    sensitive: Boolean(entry.sensitive),
    createdAt: entry.createdAt,
    source: entry.source,
  };
}

export function listLibrary({ home = defaultHome(), query = '' } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  const entries = readAllEntries(libraryRoot(home)).map(summaryOf);
  const filtered = q
    ? entries.filter(
        (entry) =>
          entry.setName.toLowerCase().includes(q) ||
          String(entry.libraryId).toLowerCase().includes(q) ||
          String(entry.source?.projectName ?? '').toLowerCase().includes(q),
      )
    : entries;
  return { total: filtered.length, entries: filtered };
}

export function getLibraryEntry(libraryId, { home = defaultHome() } = {}) {
  const entry = readEntry(libraryRoot(home), libraryId);
  return {
    ...summaryOf(entry),
    cases: entry.cases,
  };
}

/** 把项目内冻结的测试集版本提升为全局快照；同名测试集自动递增库版本。 */
export function promoteTestSet(ctx, { testSetVersionId, setName = null, license = null, sensitive = false, home = defaultHome() } = {}) {
  const detail = getTestSetVersion(ctx, testSetVersionId);
  const name = String(setName ?? detail.name).trim();
  if (!name) throw createError('VALIDATION_INVALID_REQUEST', { message: '提升到用例库需要非空测试集名称。' });
  const root = libraryRoot(home);
  mkdirSync(entriesDir(root), { recursive: true });

  const cases = detail.cases.map((item) => ({ input: item.input, expected: item.expected, meta: item.meta }));
  const contentHash = hashJson({ cases });
  const previous = readAllEntries(root).filter((entry) => entry.setName === name);
  const version = previous.reduce((max, entry) => Math.max(max, Number(entry.version) || 0), 0) + 1;
  const entry = {
    schema: ENTRY_SCHEMA,
    libraryId: ulid(),
    setName: name,
    version,
    caseCount: cases.length,
    contentHash,
    license: license ? String(license).trim() : null,
    sensitive: Boolean(sensitive),
    createdAt: nowIso(),
    source: {
      projectId: ctx.projectId,
      projectName: ctx.manifest?.name ?? null,
      testSetId: detail.testSetId,
      testSetVersionId: detail.testSetVersionId,
      testSetVersionNumber: detail.versionNumber,
    },
    cases,
  };
  const target = entryPath(root, entry.libraryId);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, target);
  return summaryOf(entry);
}

/** 将库中固定快照复制进目标项目，生成新的测试集版本并记录来源。 */
export function importLibraryEntry(ctx, { libraryId, setName = null, home = defaultHome() } = {}) {
  const entry = readEntry(libraryRoot(home), libraryId);
  const targetName = String(setName ?? entry.setName).trim();
  if (!targetName) throw createError('VALIDATION_INVALID_REQUEST', { message: '导入用例库需要非空测试集名称。' });

  const imported = importCases(ctx, {
    records: entry.cases,
    setName: targetName,
    source: `library:${entry.libraryId}`,
  });
  ctx.db
    .prepare(
      `INSERT INTO test_set_origins(
         test_set_version_id, library_id, library_version, source_project_id, source_project_name,
         source_test_set_version_id, license, sensitive, imported_at
       ) VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(test_set_version_id) DO NOTHING`,
    )
    .run(
      imported.testSetVersionId,
      entry.libraryId,
      entry.version,
      entry.source?.projectId ?? null,
      entry.source?.projectName ?? null,
      entry.source?.testSetVersionId ?? null,
      entry.license ?? null,
      entry.sensitive ? 1 : 0,
      nowIso(),
    );

  const warnings = [];
  if (entry.sensitive) {
    warnings.push({ code: 'LIBRARY_SENSITIVE_SOURCE', message: '来源快照标记为敏感数据，请在目标项目中确认使用范围。' });
  }
  if (!entry.license) {
    warnings.push({ code: 'LIBRARY_LICENSE_MISSING', message: '来源快照未记录许可证，复用前建议补充许可信息。' });
  }
  return { ...imported, library: summaryOf(entry), warnings };
}

export function testSetOrigin(ctx, versionId) {
  const row = ctx.db.prepare('SELECT * FROM test_set_origins WHERE test_set_version_id = ?').get(versionId);
  if (!row) return null;
  return {
    libraryId: row.library_id,
    libraryVersion: row.library_version,
    sourceProjectId: row.source_project_id,
    sourceProjectName: row.source_project_name,
    sourceTestSetVersionId: row.source_test_set_version_id,
    license: row.license,
    sensitive: Boolean(row.sensitive),
    importedAt: row.imported_at,
  };
}
