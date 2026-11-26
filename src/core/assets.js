import { createError } from './errors.js';
import { hashText, hashJson, normalizeText } from './hash.js';
import { ulid } from './ids.js';
import { nowIso } from './time.js';
import { transaction } from './db.js';
import { recordAudit } from './audit.js';

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function extractVariables(content) {
  const found = new Set();
  for (const match of String(content).matchAll(VARIABLE_PATTERN)) found.add(match[1]);
  return [...found].sort();
}

export function renderPrompt(content, input) {
  const variables = extractVariables(content);
  const values = typeof input === 'object' && input !== null ? input : {};
  const missing = [];
  const rendered = String(content).replace(VARIABLE_PATTERN, (_, name) => {
    if (values[name] === undefined || values[name] === null) {
      missing.push(name);
      return `{{${name}}}`;
    }
    return String(values[name]);
  });
  return { rendered, missing, variables };
}

export function createPrompt(ctx, { name, description = null }) {
  const clean = String(name ?? '').trim();
  if (!clean) throw createError('VALIDATION_INVALID_REQUEST', { message: '提示词名称不能为空。' });
  const existing = ctx.db.prepare('SELECT * FROM prompts WHERE name = ?').get(clean);
  if (existing) {
    throw createError('STATE_INVALID_TRANSITION', { message: `提示词 "${clean}" 已存在。`, details: { promptId: existing.id } });
  }
  const id = ulid();
  ctx.db
    .prepare('INSERT INTO prompts(id, project_id, name, description, created_at) VALUES(?,?,?,?,?)')
    .run(id, ctx.projectId, clean, description, nowIso());
  return { promptId: id, name: clean };
}

export function ensurePrompt(ctx, { name, description = null }) {
  const existing = ctx.db.prepare('SELECT * FROM prompts WHERE name = ?').get(String(name).trim());
  if (existing) return { promptId: existing.id, name: existing.name, created: false };
  return { ...createPrompt(ctx, { name, description }), created: true };
}

export function addVariant(ctx, { promptName, promptId, label, content, createIfMissing = false }) {
  const text = normalizeText(content ?? '');
  if (!text.trim()) throw createError('VALIDATION_INVALID_REQUEST', { message: '提示词内容不能为空。' });
  const variantLabel = String(label ?? '').trim();
  if (!variantLabel) throw createError('VALIDATION_INVALID_REQUEST', { message: '分支标签不能为空。' });

  const result = transaction(ctx.db, () => {
    let prompt = promptId
      ? ctx.db.prepare('SELECT * FROM prompts WHERE id = ?').get(promptId)
      : ctx.db.prepare('SELECT * FROM prompts WHERE name = ?').get(String(promptName ?? '').trim());
    if (!prompt) {
      if (!createIfMissing) throw createError('NOT_FOUND_PROMPT_VERSION', { message: `提示词不存在: ${promptName ?? promptId}` });
      const created = createPrompt(ctx, { name: promptName });
      prompt = ctx.db.prepare('SELECT * FROM prompts WHERE id = ?').get(created.promptId);
    }
    let variant = ctx.db.prepare('SELECT * FROM prompt_variants WHERE prompt_id = ? AND label = ?').get(prompt.id, variantLabel);
    if (!variant) {
      const variantId = ulid();
      ctx.db
        .prepare('INSERT INTO prompt_variants(id, prompt_id, label, created_at) VALUES(?,?,?,?)')
        .run(variantId, prompt.id, variantLabel, nowIso());
      variant = { id: variantId, prompt_id: prompt.id, label: variantLabel };
    }
    const latest = ctx.db
      .prepare('SELECT * FROM prompt_versions WHERE variant_id = ? ORDER BY version_number DESC LIMIT 1')
      .get(variant.id);
    const contentHash = hashText(text);
    if (latest && latest.content_hash === contentHash) {
      return { promptId: prompt.id, promptName: prompt.name, variantId: variant.id, label: variant.label, versionId: latest.id, versionNumber: latest.version_number, contentHash, created: false };
    }
    const versionId = ulid();
    const versionNumber = (latest?.version_number ?? 0) + 1;
    ctx.db
      .prepare(
        'INSERT INTO prompt_versions(id, variant_id, version_number, content, variables_json, content_hash, created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(versionId, variant.id, versionNumber, text, JSON.stringify(extractVariables(text)), contentHash, nowIso());
    return { promptId: prompt.id, promptName: prompt.name, variantId: variant.id, label: variant.label, versionId, versionNumber, contentHash, created: true };
  });
  if (result.created) {
    recordAudit(ctx, 'prompt.version_added', {
      promptId: result.promptId,
      promptName: result.promptName,
      variantId: result.variantId,
      label: result.label,
      versionId: result.versionId,
      versionNumber: result.versionNumber,
    });
  }
  return result;
}

export function restorePromptVersion(ctx, versionId) {
  const result = transaction(ctx.db, () => {
    const source = ctx.db
      .prepare(
        `SELECT pv.*, p.id AS prompt_id, p.name AS prompt_name, v.id AS variant_id, v.label
         FROM prompt_versions pv
         JOIN prompt_variants v ON v.id = pv.variant_id
         JOIN prompts p ON p.id = v.prompt_id
         WHERE pv.id = ?`,
      )
      .get(versionId);
    if (!source) throw createError('NOT_FOUND_PROMPT_VERSION', { message: `提示词版本不存在: ${versionId}` });
    const latest = ctx.db
      .prepare('SELECT * FROM prompt_versions WHERE variant_id = ? ORDER BY version_number DESC LIMIT 1')
      .get(source.variant_id);
    if (latest?.content_hash === source.content_hash) {
      return {
        promptId: source.prompt_id,
        promptName: source.prompt_name,
        variantId: source.variant_id,
        label: source.label,
        versionId: latest.id,
        versionNumber: latest.version_number,
        contentHash: latest.content_hash,
        restoredFromVersionId: versionId,
        created: false,
      };
    }
    const newVersionId = ulid();
    const versionNumber = (latest?.version_number ?? 0) + 1;
    ctx.db
      .prepare('INSERT INTO prompt_versions(id, variant_id, version_number, content, variables_json, content_hash, created_at) VALUES(?,?,?,?,?,?,?)')
      .run(
        newVersionId,
        source.variant_id,
        versionNumber,
        source.content,
        source.variables_json,
        source.content_hash,
        nowIso(),
      );
    return {
      promptId: source.prompt_id,
      promptName: source.prompt_name,
      variantId: source.variant_id,
      label: source.label,
      versionId: newVersionId,
      versionNumber,
      contentHash: source.content_hash,
      restoredFromVersionId: versionId,
      created: true,
    };
  });
  if (result.created) {
    recordAudit(ctx, 'prompt.version_restored', {
      promptId: result.promptId,
      promptName: result.promptName,
      variantId: result.variantId,
      label: result.label,
      versionId: result.versionId,
      versionNumber: result.versionNumber,
      restoredFromVersionId: result.restoredFromVersionId,
    });
  }
  return result;
}

export function listPrompts(ctx) {
  const prompts = ctx.db.prepare('SELECT * FROM prompts ORDER BY created_at, id').all();
  return prompts.map((prompt) => {
    const variants = ctx.db.prepare('SELECT * FROM prompt_variants WHERE prompt_id = ? ORDER BY created_at, id').all(prompt.id);
    return {
      promptId: prompt.id,
      name: prompt.name,
      description: prompt.description,
      createdAt: prompt.created_at,
      variants: variants.map((variant) => {
        const versions = ctx.db
          .prepare('SELECT id, version_number, content_hash, variables_json, created_at FROM prompt_versions WHERE variant_id = ? ORDER BY version_number DESC')
          .all(variant.id);
        return {
          variantId: variant.id,
          label: variant.label,
          latestVersionId: versions[0]?.id ?? null,
          latestVersionNumber: versions[0]?.version_number ?? null,
          versions: versions.map((version) => ({
            versionId: version.id,
            versionNumber: version.version_number,
            contentHash: version.content_hash,
            variables: JSON.parse(version.variables_json),
            createdAt: version.created_at,
          })),
        };
      }),
    };
  });
}

export function getPromptVersion(ctx, versionId) {
  const row = ctx.db
    .prepare(
      `SELECT pv.*, v.label, v.prompt_id, p.name AS prompt_name
       FROM prompt_versions pv
       JOIN prompt_variants v ON v.id = pv.variant_id
       JOIN prompts p ON p.id = v.prompt_id
       WHERE pv.id = ?`,
    )
    .get(versionId);
  if (!row) throw createError('NOT_FOUND_PROMPT_VERSION', { message: `提示词版本不存在: ${versionId}` });
  return {
    versionId: row.id,
    promptId: row.prompt_id,
    promptName: row.prompt_name,
    variantId: row.variant_id,
    label: row.label,
    versionNumber: row.version_number,
    content: row.content,
    variables: JSON.parse(row.variables_json),
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

export function diffPromptVersions(ctx, leftId, rightId) {
  const left = getPromptVersion(ctx, leftId);
  const right = getPromptVersion(ctx, rightId);
  return {
    left: { versionId: left.versionId, label: left.label, versionNumber: left.versionNumber, contentHash: left.contentHash },
    right: { versionId: right.versionId, label: right.label, versionNumber: right.versionNumber, contentHash: right.contentHash },
    identical: left.contentHash === right.contentHash,
    lines: diffLines(left.content, right.content),
  };
}

/** 行级 LCS diff，输出 {type:'equal'|'add'|'remove', line, leftLine, rightLine}。 */
export function diffLines(a, b) {
  const left = normalizeText(a).split('\n');
  const right = normalizeText(b).split('\n');
  const table = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const result = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      result.push({ type: 'equal', line: left[i], leftLine: i + 1, rightLine: j + 1 });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      result.push({ type: 'remove', line: left[i], leftLine: i + 1 });
      i++;
    } else {
      result.push({ type: 'add', line: right[j], rightLine: j + 1 });
      j++;
    }
  }
  while (i < left.length) result.push({ type: 'remove', line: left[i], leftLine: ++i });
  while (j < right.length) result.push({ type: 'add', line: right[j], rightLine: ++j });
  return result;
}

/** 导入提示词文档：支持单对象或数组，原子导入。 */
export function importPrompts(ctx, document) {
  const documents = Array.isArray(document) ? document : [document];
  const results = [];
  for (const doc of documents) {
    if (!doc || typeof doc !== 'object') {
      throw createError('VALIDATION_INVALID_REQUEST', { message: '提示词导入文件结构非法。' });
    }
    const name = typeof doc.prompt === 'string' ? doc.prompt : (doc.prompt?.name ?? doc.name);
    const description = typeof doc.prompt === 'object' ? doc.prompt.description : doc.description;
    if (!name) throw createError('VALIDATION_INVALID_REQUEST', { message: '提示词导入缺少名称。' });
    const variants = doc.variants ?? doc.branches;
    if (!Array.isArray(variants) || variants.length < 2) {
      throw createError('VALIDATION_INVALID_REQUEST', { message: `提示词 "${name}" 需要至少两个分支。`, details: { prompt: name } });
    }
    const { promptId } = ensurePrompt(ctx, { name, description: description ?? null });
    for (const variant of variants) {
      if (!variant.label || typeof variant.content !== 'string') {
        throw createError('VALIDATION_INVALID_REQUEST', { message: `提示词 "${name}" 的分支缺少 label 或 content。` });
      }
      results.push(addVariant(ctx, { promptId, label: variant.label, content: variant.content }));
    }
  }
  const promptIds = results.map((item) => item.promptId).filter((value, index, array) => array.indexOf(value) === index);
  recordAudit(ctx, 'prompt.imported', {
    prompts: promptIds.length,
    variants: results.length,
    createdVersions: results.filter((item) => item.created).length,
  });
  return { prompts: promptIds, variants: results };
}

export function contentSignature(parts) {
  return hashJson(parts);
}
