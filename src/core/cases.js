import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { createError } from './errors.js';
import { hashJson } from './hash.js';
import { ulid } from './ids.js';
import { nowIso } from './time.js';
import { transaction } from './db.js';
import { recordAudit } from './audit.js';

export function parseCasesText(text, formatHint) {
  const format = (formatHint ?? '').toLowerCase();
  if (format === 'json') return parseJsonCases(text);
  if (format === 'jsonl' || format === 'ndjson') return parseJsonlCases(text);
  if (format === 'csv') return parseCsvCases(text);
  throw createError('VALIDATION_UNSUPPORTED_FORMAT', { message: `不支持用例导入格式: ${formatHint}` });
}

export function parseCasesFile(path) {
  if (!existsSync(path)) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: `用例文件不存在: ${path}` });
  }
  const ext = extname(path).toLowerCase().replace('.', '');
  const map = { json: 'json', jsonl: 'jsonl', ndjson: 'jsonl', csv: 'csv' };
  if (!map[ext]) throw createError('VALIDATION_UNSUPPORTED_FORMAT', { message: `不支持的用例文件扩展名: .${ext}` });
  return parseCasesText(readFileSync(path, 'utf8'), map[ext]);
}

function parseJsonCases(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: `JSON 解析失败: ${error.message}` });
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.cases)) return parsed.cases;
  if (parsed && typeof parsed === 'object') return [parsed];
  throw createError('VALIDATION_INVALID_REQUEST', { message: 'JSON 用例必须是数组或 { cases: [] }。' });
}

function parseJsonlCases(text) {
  const records = [];
  const failures = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      records.push(JSON.parse(trimmed));
    } catch (error) {
      failures.push({ line: index + 1, message: error.message });
    }
  });
  if (failures.length) {
    throw createError('VALIDATION_INVALID_REQUEST', {
      message: 'JSONL 中存在无法解析的行。',
      details: { sampleErrors: failures.slice(0, 5), totalErrors: failures.length },
    });
  }
  return records;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\r') {
      // 忽略 CR，等待 LF
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseCsvCases(text) {
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw createError('VALIDATION_INVALID_REQUEST', { message: 'CSV 至少需要表头和一行用例。' });
  const headers = rows[0].map((header) => header.trim());
  if (!headers.some((header) => header === 'input' || header === 'input_json')) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: 'CSV 必须包含 input 或 input_json 列。' });
  }
  return rows.slice(1).filter((row) => row.some((cell) => cell.trim() !== '')).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      const cell = row[index] ?? '';
      if (!header) return;
      record[header] = cell;
    });
    return record;
  });
}

export { normalizeRecord as normalizeCaseRecord };

function normalizeRecord(record, index) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { error: `第 ${index + 1} 条用例不是对象。` };
  }
  let input = record.input;
  if (input === undefined && record.input_json !== undefined) input = parseMaybeJson(record.input_json, `第 ${index + 1} 条 input_json`);
  if (input === undefined) return { error: `第 ${index + 1} 条用例缺少 input。` };
  let expected = record.expected;
  if (expected === undefined && record.expected_json !== undefined) {
    expected = parseMaybeJson(record.expected_json, `第 ${index + 1} 条 expected_json`);
  }
  let meta = record.meta;
  if (meta === undefined && record.meta_json !== undefined) {
    meta = parseMaybeJson(record.meta_json, `第 ${index + 1} 条 meta_json`);
  }
  if (meta !== undefined && meta !== null && (typeof meta !== 'object' || Array.isArray(meta))) {
    return { error: `第 ${index + 1} 条 meta 必须是对象。` };
  }
  if (typeof input === 'string') input = input.trim();
  if (input === '') return { error: `第 ${index + 1} 条 input 为空。` };
  return { case: { input, expected: expected ?? null, meta: meta ?? null, externalId: record.id ?? record.external_id ?? null } };
}

function parseMaybeJson(value, label) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export function importCases(ctx, { records, setName, source = 'inline' }) {
  if (!Array.isArray(records) || !records.length) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: '用例导入内容为空。' });
  }
  const set = String(setName ?? '').trim();
  if (!set) throw createError('VALIDATION_INVALID_REQUEST', { message: '导入用例需要 --set 指定测试集名称。' });

  const failures = [];
  const normalized = [];
  records.forEach((record, index) => {
    const result = normalizeRecord(record, index);
    if (result.error) failures.push({ index, message: result.error });
    else normalized.push(result.case);
  });
  if (failures.length) {
    throw createError('VALIDATION_INVALID_REQUEST', {
      message: '用例校验失败，导入已整体取消。',
      details: { sampleErrors: failures.slice(0, 5), totalErrors: failures.length },
    });
  }

  const result = transaction(ctx.db, () => {
    const batchId = ulid();
    let imported = 0;
    let duplicates = 0;
    const caseIds = normalized.map((item) => {
      const contentHash = hashJson({ input: item.input, expected: item.expected, meta: item.meta });
      const existing = ctx.db.prepare('SELECT id FROM cases WHERE content_hash = ?').get(contentHash);
      if (existing) {
        duplicates++;
        return existing.id;
      }
      const id = ulid();
      ctx.db
        .prepare('INSERT INTO cases(id, content_hash, input_json, expected_json, meta_json, created_at) VALUES(?,?,?,?,?,?)')
        .run(id, contentHash, JSON.stringify(item.input), item.expected === null ? null : JSON.stringify(item.expected), item.meta === null ? null : JSON.stringify(item.meta), nowIso());
      imported++;
      return id;
    });

    let testSet = ctx.db.prepare('SELECT * FROM test_sets WHERE name = ?').get(set);
    if (!testSet) {
      const testSetId = ulid();
      ctx.db.prepare('INSERT INTO test_sets(id, name, created_at) VALUES(?,?,?)').run(testSetId, set, nowIso());
      testSet = { id: testSetId, name: set };
    }
    const latest = ctx.db
      .prepare('SELECT * FROM test_set_versions WHERE test_set_id = ? ORDER BY version_number DESC LIMIT 1')
      .get(testSet.id);
    const priorIds = latest
      ? ctx.db.prepare('SELECT case_id FROM test_set_cases WHERE test_set_version_id = ? ORDER BY position').all(latest.id).map((row) => row.case_id)
      : [];
    const merged = [...priorIds];
    for (const id of caseIds) if (!merged.includes(id)) merged.push(id);

    const contentHash = hashJson({ cases: merged });
    if (latest && latest.content_hash === contentHash) {
      return {
        batchId,
        testSetId: testSet.id,
        testSetName: testSet.name,
        testSetVersionId: latest.id,
        contentHash,
        imported,
        duplicates,
        caseCount: merged.length,
        newVersion: false,
        source,
      };
    }
    const testSetVersionId = ulid();
    const versionNumber = (latest?.version_number ?? 0) + 1;
    ctx.db
      .prepare('INSERT INTO test_set_versions(id, test_set_id, version_number, content_hash, case_count, created_at) VALUES(?,?,?,?,?,?)')
      .run(testSetVersionId, testSet.id, versionNumber, contentHash, merged.length, nowIso());
    merged.forEach((caseId, position) => {
      ctx.db.prepare('INSERT INTO test_set_cases(test_set_version_id, case_id, position) VALUES(?,?,?)').run(testSetVersionId, caseId, position);
    });
    return {
      batchId,
      testSetId: testSet.id,
      testSetName: testSet.name,
      testSetVersionId,
      contentHash,
      imported,
      duplicates,
      caseCount: merged.length,
      newVersion: true,
      versionNumber,
      source,
    };
  });
  recordAudit(ctx, 'cases.imported', {
    testSetId: result.testSetId,
    testSetName: result.testSetName,
    testSetVersionId: result.testSetVersionId,
    imported: result.imported,
    duplicates: result.duplicates,
    caseCount: result.caseCount,
    source: result.source,
  });
  return result;
}

export function listTestSets(ctx) {
  return ctx.db.prepare('SELECT * FROM test_sets ORDER BY created_at, id').all().map((set) => {
    const versions = ctx.db
      .prepare('SELECT * FROM test_set_versions WHERE test_set_id = ? ORDER BY version_number DESC')
      .all(set.id);
    const latest = versions[0];
    return {
      testSetId: set.id,
      name: set.name,
      createdAt: set.created_at,
      latestVersionId: latest?.id ?? null,
      latestVersionNumber: latest?.version_number ?? null,
      contentHash: latest?.content_hash ?? null,
      caseCount: latest?.case_count ?? 0,
      versions: versions.map((version) => ({
        testSetVersionId: version.id,
        versionNumber: version.version_number,
        contentHash: version.content_hash,
        caseCount: version.case_count,
        createdAt: version.created_at,
      })),
    };
  });
}

export function getTestSetVersion(ctx, versionId) {
  const version = ctx.db.prepare('SELECT * FROM test_set_versions WHERE id = ?').get(versionId);
  if (!version) throw createError('VALIDATION_INVALID_REQUEST', { message: `测试集版本不存在: ${versionId}` });
  const set = ctx.db.prepare('SELECT * FROM test_sets WHERE id = ?').get(version.test_set_id);
  const cases = ctx.db
    .prepare(
      `SELECT c.* FROM test_set_cases tsc JOIN cases c ON c.id = tsc.case_id
       WHERE tsc.test_set_version_id = ? ORDER BY tsc.position`,
    )
    .all(versionId)
    .map((row) => ({
      caseVersionId: row.id,
      contentHash: row.content_hash,
      input: JSON.parse(row.input_json),
      expected: row.expected_json ? JSON.parse(row.expected_json) : null,
      meta: row.meta_json ? JSON.parse(row.meta_json) : null,
    }));
  return {
    testSetId: version.test_set_id,
    name: set.name,
    testSetVersionId: version.id,
    versionNumber: version.version_number,
    contentHash: version.content_hash,
    caseCount: version.case_count,
    cases,
    createdAt: version.created_at,
  };
}

export function getTestSetByName(ctx, name) {
  const set = ctx.db.prepare('SELECT * FROM test_sets WHERE name = ?').get(String(name).trim());
  if (!set) throw createError('VALIDATION_INVALID_REQUEST', { message: `测试集不存在: ${name}` });
  const latest = ctx.db
    .prepare('SELECT * FROM test_set_versions WHERE test_set_id = ? ORDER BY version_number DESC LIMIT 1')
    .get(set.id);
  if (!latest) throw createError('VALIDATION_INVALID_REQUEST', { message: `测试集 "${name}" 还没有任何用例。` });
  return getTestSetVersion(ctx, latest.id);
}

export function listCases(ctx, setVersionId = null) {
  if (setVersionId) return getTestSetVersion(ctx, setVersionId).cases;
  return ctx.db.prepare('SELECT * FROM cases ORDER BY created_at, id').all().map((row) => ({
    caseVersionId: row.id,
    contentHash: row.content_hash,
    input: JSON.parse(row.input_json),
    expected: row.expected_json ? JSON.parse(row.expected_json) : null,
    meta: row.meta_json ? JSON.parse(row.meta_json) : null,
  }));
}
