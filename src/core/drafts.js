import { createError } from './errors.js';
import { ulid } from './ids.js';
import { nowIso } from './time.js';

/**
 * 实验草稿：向导的可恢复编辑态，不是实验版本。
 * 不写入快照、报告与审计事实，删除草稿不影响历史运行。
 */
export function listDrafts(ctx) {
  return ctx.db
    .prepare('SELECT * FROM experiment_drafts WHERE project_id = ? ORDER BY updated_at DESC')
    .all(ctx.projectId)
    .map(mapDraft);
}

export function getDraft(ctx, draftId) {
  const row = ctx.db.prepare('SELECT * FROM experiment_drafts WHERE id = ?').get(draftId);
  if (!row) throw createError('NOT_FOUND_DRAFT', { message: `实验草稿不存在: ${draftId}` });
  return mapDraft(row);
}

export function createDraft(ctx, { name = null, step = 1, payload = {} } = {}) {
  const id = ulid();
  const at = nowIso();
  ctx.db
    .prepare('INSERT INTO experiment_drafts(id, project_id, name, step, payload_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, ctx.projectId, name, clampStep(step), JSON.stringify(payload ?? {}), at, at);
  return getDraft(ctx, id);
}

export function updateDraft(ctx, draftId, patch = {}) {
  const current = getDraft(ctx, draftId);
  const step = patch.step === undefined ? current.step : clampStep(patch.step);
  const name = patch.name === undefined ? current.name : patch.name;
  const payload = patch.payload === undefined ? current.payload : patch.payload;
  ctx.db
    .prepare('UPDATE experiment_drafts SET name = ?, step = ?, payload_json = ?, updated_at = ? WHERE id = ?')
    .run(name, step, JSON.stringify(payload ?? {}), nowIso(), draftId);
  return getDraft(ctx, draftId);
}

export function deleteDraft(ctx, draftId) {
  const result = ctx.db.prepare('DELETE FROM experiment_drafts WHERE id = ?').run(draftId);
  if (!result.changes) throw createError('NOT_FOUND_DRAFT', { message: `实验草稿不存在: ${draftId}` });
  return { draftId, deleted: true };
}

function clampStep(step) {
  const value = Number(step);
  if (!Number.isInteger(value) || value < 1 || value > 5) return 1;
  return value;
}

function mapDraft(row) {
  let payload = {};
  try {
    payload = JSON.parse(row.payload_json ?? '{}');
  } catch {
    payload = {};
  }
  return {
    draftId: row.id,
    projectId: row.project_id,
    name: row.name,
    step: row.step,
    payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
