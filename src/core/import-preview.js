import { createError } from './errors.js';
import { hashJson } from './hash.js';
import { ulid } from './ids.js';
import { nowIso } from './time.js';
import { parseCasesText, normalizeCaseRecord, importCases } from './cases.js';

const PREVIEW_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ERRORS = 50;

/**
 * 两阶段导入：先解析、映射与校验，返回 previewId；commit 时才写入数据库。
 * 预览只保存规范化后的用例与错误样本，不落业务表。
 */
export function createImportPreview(ctx, { text, format, setName = null, mapping = null } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: '导入内容为空。' });
  }
  const normalizedFormat = normalizeFormat(format);
  const rawRecords = parseCasesText(text, normalizedFormat);
  const records = mapping && normalizedFormat === 'csv' ? applyMapping(rawRecords, mapping) : rawRecords;

  const errors = [];
  const valid = [];
  rawRecords.forEach((record, index) => {
    const result = normalizeCaseRecord(record, index);
    if (result.error) errors.push({ row: index + 1, message: result.error });
    else valid.push(result.case);
  });

  let duplicates = 0;
  for (const item of valid) {
    const contentHash = hashJson({ input: item.input, expected: item.expected, meta: item.meta });
    const existing = ctx.db.prepare('SELECT id FROM cases WHERE content_hash = ?').get(contentHash);
    if (existing) duplicates++;
  }

  cleanupExpired(ctx);
  const previewId = ulid();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
  ctx.db
    .prepare(
      `INSERT INTO import_previews(id, project_id, set_name, format, mapping_json, records_json, errors_json, columns_json, created_at, expires_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      previewId,
      ctx.projectId,
      setName,
      normalizedFormat,
      mapping ? JSON.stringify(mapping) : null,
      JSON.stringify(valid),
      JSON.stringify(errors),
      JSON.stringify(collectColumns(rawRecords)),
      createdAt,
      expiresAt,
    );

  return {
    previewId,
    format: normalizedFormat,
    setName,
    totalRecords: rawRecords.length,
    validRecords: valid.length,
    errorCount: errors.length,
    errors: errors.slice(0, MAX_ERRORS),
    duplicateRecords: duplicates,
    columns: collectColumns(rawRecords),
    sample: valid.slice(0, 10),
    expiresAt,
  };
}

export function commitImportPreview(ctx, { previewId, setName = null, duplicatePolicy = 'reuse' } = {}) {
  if (!previewId) throw createError('VALIDATION_INVALID_REQUEST', { message: '提交导入需要 previewId。' });
  const row = ctx.db.prepare('SELECT * FROM import_previews WHERE id = ?').get(previewId);
  if (!row || row.project_id !== ctx.projectId) {
    throw createError('NOT_FOUND_PREVIEW', { message: `导入预览不存在: ${previewId}` });
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    ctx.db.prepare('DELETE FROM import_previews WHERE id = ?').run(previewId);
    throw createError('NOT_FOUND_PREVIEW', { message: '导入预览已过期，请重新上传。' });
  }
  const targetSet = setName ?? row.set_name;
  if (!targetSet) throw createError('VALIDATION_INVALID_REQUEST', { message: '提交导入需要测试集名称。' });
  const errors = JSON.parse(row.errors_json ?? '[]');
  if (errors.length) {
    throw createError('VALIDATION_INVALID_REQUEST', {
      message: '预览中存在校验失败的记录，请修正后重新上传。',
      details: { sampleErrors: errors.slice(0, 5), totalErrors: errors.length },
    });
  }

  let records = JSON.parse(row.records_json ?? '[]');
  if (!records.length) throw createError('VALIDATION_INVALID_REQUEST', { message: '导入预览没有可提交的记录。' });
  if (duplicatePolicy === 'skip') {
    records = records.filter((item) => {
      const contentHash = hashJson({ input: item.input, expected: item.expected, meta: item.meta });
      return !ctx.db.prepare('SELECT id FROM cases WHERE content_hash = ?').get(contentHash);
    });
    if (!records.length) {
      return { previewId, imported: 0, duplicates: 0, skippedAll: true, testSetName: targetSet };
    }
  }
  const result = importCases(ctx, { records, setName: targetSet, source: `preview:${previewId}` });
  ctx.db.prepare('DELETE FROM import_previews WHERE id = ?').run(previewId);
  return { previewId, duplicatePolicy, ...result };
}

export function getImportPreview(ctx, previewId) {
  const row = ctx.db.prepare('SELECT * FROM import_previews WHERE id = ?').get(previewId);
  if (!row) throw createError('NOT_FOUND_PREVIEW', { message: `导入预览不存在: ${previewId}` });
  return {
    previewId: row.id,
    format: row.format,
    setName: row.set_name,
    columns: JSON.parse(row.columns_json ?? '[]'),
    totalRecords: JSON.parse(row.records_json ?? '[]').length,
    errors: JSON.parse(row.errors_json ?? '[]'),
    sample: JSON.parse(row.records_json ?? '[]').slice(0, 10),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function normalizeFormat(format) {
  const value = String(format ?? '').toLowerCase();
  if (value === 'jsonl' || value === 'ndjson') return 'jsonl';
  if (value === 'json') return 'json';
  if (value === 'csv') return 'csv';
  throw createError('VALIDATION_UNSUPPORTED_FORMAT', { message: `不支持用例导入格式: ${format}` });
}

function applyMapping(records, mapping) {
  const inputColumn = mapping.input;
  if (!inputColumn) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: 'CSV 字段映射必须指定 input 列。' });
  }
  return records.map((record) => {
    const mapped = { input: record[inputColumn] };
    if (mapping.expected) mapped.expected = record[mapping.expected];
    if (mapping.meta) mapped.meta = record[mapping.meta];
    if (mapping.externalId) mapped.id = record[mapping.externalId];
    return mapped;
  });
}

function collectColumns(records) {
  const columns = new Set();
  for (const record of records.slice(0, 200)) {
    if (record && typeof record === 'object' && !Array.isArray(record)) {
      for (const key of Object.keys(record)) columns.add(key);
    }
  }
  return [...columns].slice(0, 40);
}

function cleanupExpired(ctx) {
  ctx.db.prepare('DELETE FROM import_previews WHERE expires_at < ?').run(nowIso());
}
