import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createError } from './errors.js';
import { ulid } from './ids.js';
import { nowIso } from './time.js';
import { addModel, validateBaseUrl, validateModelInput } from './models.js';

export const MODEL_LIBRARY_SCHEMA = 'promptlens.model-library/v1';
const MAX_ENTRIES = 100;

/**
 * 跨项目模型库：只保存模型模板（含 env:/keychain: 凭据引用），不保存任何密钥明文。
 * 项目内模型仍是版本化真源，从这里导入等价于在项目里新建/复用一份配置。
 */
export function modelLibraryPath(home) {
  return join(resolve(home), 'model-library.json');
}

export function readModelLibrary(home) {
  const path = modelLibraryPath(home);
  if (!existsSync(path)) return { schema: MODEL_LIBRARY_SCHEMA, entries: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw createError('VALIDATION_SCHEMA_INVALID', {
      message: `模型库无法解析: ${error.message}`,
      details: { path },
      remediation: '修复或删除 model-library.json 后重试。',
    });
  }
  if (!parsed || parsed.schema !== MODEL_LIBRARY_SCHEMA || !Array.isArray(parsed.entries)) {
    throw createError('VALIDATION_SCHEMA_INVALID', { message: '模型库格式无效。', details: { path } });
  }
  return {
    schema: MODEL_LIBRARY_SCHEMA,
    entries: parsed.entries.filter(isEntry).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
  };
}

export function saveModelLibraryEntry(home, input) {
  const library = readModelLibrary(home);
  const entry = normalizeEntry(input);
  const existing = library.entries.find((item) => item.name === entry.name);
  if (existing && existing.providerType !== entry.providerType) {
    throw createError('STATE_INVALID_TRANSITION', {
      message: `模型库条目 "${entry.name}" 已存在且 providerType 不同。`,
      details: { existing: existing.providerType, requested: entry.providerType },
    });
  }
  const now = nowIso();
  let saved;
  if (existing) {
    saved = { ...existing, ...entry, updatedAt: now };
    library.entries = [saved, ...library.entries.filter((item) => item.id !== existing.id)];
  } else {
    saved = { id: ulid(), ...entry, createdAt: now, updatedAt: now };
    library.entries = [saved, ...library.entries];
  }
  if (library.entries.length > MAX_ENTRIES) library.entries = library.entries.slice(0, MAX_ENTRIES);
  persistModelLibrary(home, library);
  return saved;
}

export function deleteModelLibraryEntry(home, id) {
  const library = readModelLibrary(home);
  const next = library.entries.filter((item) => item.id !== id);
  if (next.length === library.entries.length) {
    throw createError('NOT_FOUND_MODEL', { message: `模型库条目不存在: ${id}` });
  }
  persistModelLibrary(home, { ...library, entries: next });
  return { id, deleted: true };
}

/** 把库条目复制为项目内模型配置；同名且配置相同则复用现版本。 */
export function importModelLibraryEntry(ctx, home, libraryId, options = {}) {
  const entry = readModelLibrary(home).entries.find((item) => item.id === libraryId);
  if (!entry) throw createError('NOT_FOUND_MODEL', { message: `模型库条目不存在: ${libraryId}` });
  const name = String(options.name ?? entry.name).trim() || entry.name;
  const created = addModel(ctx, {
    name,
    providerType: entry.providerType,
    modelId: entry.modelId,
    baseUrl: entry.baseUrl,
    credentialRef: entry.credentialRef,
    params: entry.params,
    pricing: entry.pricing,
  });
  return { ...created, libraryId: entry.id };
}

function normalizeEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: '模型库条目必须是对象。' });
  }
  validateModelInput(input);
  return {
    name: String(input.name).trim(),
    providerType: input.providerType,
    modelId: String(input.modelId).trim(),
    baseUrl: input.providerType === 'openai_compatible' ? validateBaseUrl(input.baseUrl) : null,
    credentialRef: input.credentialRef ?? null,
    params: input.params ?? {},
    pricing: input.pricing ?? null,
  };
}

function isEntry(value) {
  return Boolean(value) && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.modelId === 'string';
}

function persistModelLibrary(home, library) {
  const dir = resolve(home);
  const path = join(dir, 'model-library.json');
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const payload = { schema: MODEL_LIBRARY_SCHEMA, entries: library.entries };
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}
