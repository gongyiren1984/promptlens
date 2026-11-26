import { createError } from './errors.js';
import { hashJson } from './hash.js';
import { ulid } from './ids.js';
import { nowIso } from './time.js';
import { getPromptVersion } from './assets.js';
import { loadSnapshot } from './spec.js';
import { callModel, computeUsageCost, findModelByName, getModelConfigVersion } from './models.js';
import { recordAudit } from './audit.js';

const MAX_SUGGESTIONS = 10;
const DEFAULT_SUGGESTIONS = 3;
const TARGET_SCORE = 0.85;
export const SUGGESTION_STATUSES = new Set(['generated', 'accepted', 'dismissed']);

/**
 * 基于运行证据生成提示词优化建议。
 * 只产出建议清单并独立保存，不修改任何提示词版本。
 */
export async function suggestPromptOptimizations(
  ctx,
  { runId, modelConfigVersionId = null, modelRef = null, promptVersionId = null, focus = '', maxSuggestions = DEFAULT_SUGGESTIONS, signal = null, fetchImpl = null } = {},
) {
  const run = requireFinishedRun(ctx, runId);
  const snapshot = loadSnapshot(ctx, run.snapshot_id);
  const modelConfig = resolveModel(ctx, modelConfigVersionId ?? modelRef);
  const limit = clampMax(maxSuggestions);
  const base = promptVersionId ? getBaseVersion(ctx, promptVersionId, runId) : getPromptVersion(ctx, lowestVariant(ctx, runId));
  const dimensions = snapshot.evaluation.config.dimensions;
  const stats = collectDimensionStats(ctx, runId, base.versionId, dimensions);
  const overall = overallStats(ctx, runId, base.versionId);
  if (!overall.trialCount) {
    throw createError('STATE_EVIDENCE_MISSING', { message: '该运行没有可比的已评估 Trial，无法生成优化建议。' });
  }
  const summary = buildSummary(stats, overall);
  const started = Date.now();

  let suggestions;
  let usage = null;
  if (modelConfig.providerType === 'mock') {
    suggestions = mockSuggestions(stats, limit);
  } else {
    const messages = buildSuggestionMessages({ base, stats, focus });
    const result = await callModel({
      modelConfig,
      messages,
      caseMeta: null,
      variantLabel: base.label,
      attemptNumber: 1,
      signal,
      fetchImpl,
      promptText: messages.map((message) => message.content).join('\n'),
      caseInput: { runId, focus: String(focus ?? '') },
    });
    usage = result.usage ?? null;
    suggestions = parseSuggestionResponse(result.content, { stats, maxSuggestions: limit });
  }
  if (!suggestions.length) {
    throw createError('PROVIDER_INVALID_REQUEST', { message: '没有生成可用的优化建议。' });
  }

  const cost = usage ? computeUsageCost(usage, modelConfig.pricing) : { amount: null, currency: null, billingState: 'not_billed' };
  const suggestionId = ulid();
  const createdAt = nowIso();
  const payload = {
    suggestionId,
    runId,
    promptVersionId: base.versionId,
    base: {
      versionId: base.versionId,
      promptId: base.promptId,
      promptName: base.promptName,
      label: base.label,
      versionNumber: base.versionNumber,
      contentHash: base.contentHash,
    },
    evaluation: {
      profileVersionId: snapshot.evaluation.profileVersionId,
      name: snapshot.evaluation.name,
      scale: snapshot.evaluation.config.scale ?? null,
    },
    promptUnchanged: true,
    status: 'generated',
    summary,
    suggestions,
    generator: {
      modelConfigVersionId: modelConfig.modelConfigVersionId,
      name: modelConfig.name,
      providerType: modelConfig.providerType,
      focus: String(focus ?? ''),
      generatedAt: createdAt,
      latencyMs: Date.now() - started,
    },
    cost,
    usage,
    createdAt,
  };
  const contentHash = hashJson(payload);
  ctx.db
    .prepare(
      'INSERT INTO prompt_suggestions(id, project_id, run_id, prompt_version_id, model_config_version_id, status, content_hash, payload_json, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(suggestionId, ctx.projectId, runId, base.versionId, modelConfig.modelConfigVersionId, 'generated', contentHash, JSON.stringify(payload), createdAt);
  recordAudit(ctx, 'prompt.suggestions_generated', { suggestionId, runId, promptVersionId: base.versionId, count: suggestions.length, contentHash });

  return { ...payload, contentHash };
}

/** 生成前预览：证据规模、维度均值、建议条数与成本上界，不调用模型。 */
export function buildSuggestionContext(ctx, { runId, modelConfigVersionId = null, modelRef = null, promptVersionId = null, maxSuggestions = DEFAULT_SUGGESTIONS } = {}) {
  const run = requireFinishedRun(ctx, runId);
  const snapshot = loadSnapshot(ctx, run.snapshot_id);
  const modelConfig = resolveModel(ctx, modelConfigVersionId ?? modelRef);
  const limit = clampMax(maxSuggestions);
  const base = promptVersionId ? getBaseVersion(ctx, promptVersionId, runId) : getPromptVersion(ctx, lowestVariant(ctx, runId));
  const stats = collectDimensionStats(ctx, runId, base.versionId, snapshot.evaluation.config.dimensions);
  const overall = overallStats(ctx, runId, base.versionId);
  if (!overall.trialCount) {
    throw createError('STATE_EVIDENCE_MISSING', { message: '该运行没有可比的已评估 Trial，无法生成优化建议。' });
  }
  const lowDimensions = stats
    .filter((item) => item.mean != null && item.mean < TARGET_SCORE)
    .map((item) => ({ id: item.id, name: item.name, mean: round3(item.mean) }));
  return {
    runId,
    base: {
      versionId: base.versionId,
      label: base.label,
      versionNumber: base.versionNumber,
      promptName: base.promptName,
      contentHash: base.contentHash,
    },
    evaluation: {
      profileVersionId: snapshot.evaluation.profileVersionId,
      name: snapshot.evaluation.name,
      scale: snapshot.evaluation.config.scale ?? null,
    },
    generator: {
      modelConfigVersionId: modelConfig.modelConfigVersionId,
      name: modelConfig.name,
      providerType: modelConfig.providerType,
      pricing: modelConfig.pricing ?? null,
    },
    summary: buildSummary(stats, overall),
    evidenceCount: overall.trialCount,
    lowDimensions,
    maxSuggestions: { requested: limit, limit: MAX_SUGGESTIONS, default: DEFAULT_SUGGESTIONS },
    cost: estimateSuggestionCost(modelConfig),
    note: '建议只读取该运行的证据，不会修改提示词；生成后会作为独立内容保存。',
  };
}

export function updatePromptSuggestionStatus(ctx, suggestionId, status) {
  if (!SUGGESTION_STATUSES.has(status)) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: `不支持的建议状态: ${status}` });
  }
  const row = ctx.db.prepare('SELECT * FROM prompt_suggestions WHERE id = ? AND project_id = ?').get(suggestionId, ctx.projectId);
  if (!row) throw createError('NOT_FOUND_SUGGESTION', { message: `优化建议不存在: ${suggestionId}` });
  ctx.db.prepare('UPDATE prompt_suggestions SET status = ? WHERE id = ?').run(status, suggestionId);
  recordAudit(ctx, 'prompt.suggestions_status_changed', { suggestionId, status });
  return getPromptSuggestion(ctx, suggestionId);
}

export function listPromptSuggestions(ctx, { runId = null, promptVersionId = null, status = null, limit = 50 } = {}) {
  const clauses = ['project_id = ?'];
  const params = [ctx.projectId];
  if (runId) {
    clauses.push('run_id = ?');
    params.push(runId);
  }
  if (promptVersionId) {
    clauses.push('prompt_version_id = ?');
    params.push(promptVersionId);
  }
  if (status) {
    if (!SUGGESTION_STATUSES.has(status)) throw createError('VALIDATION_INVALID_REQUEST', { message: `不支持的建议状态: ${status}` });
    clauses.push('status = ?');
    params.push(status);
  }
  params.push(Math.min(200, Math.max(1, Number(limit) || 50)));
  return ctx.db
    .prepare(`SELECT * FROM prompt_suggestions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .all(...params)
    .map((row) => {
      const payload = safeJson(row.payload_json) ?? {};
      return {
        suggestionId: row.id,
        runId: row.run_id,
        promptVersionId: row.prompt_version_id,
        modelConfigVersionId: row.model_config_version_id,
        status: row.status,
        contentHash: row.content_hash,
        suggestionCount: Array.isArray(payload.suggestions) ? payload.suggestions.length : 0,
        createdAt: row.created_at,
      };
    });
}

export function getPromptSuggestion(ctx, suggestionId) {
  const row = ctx.db.prepare('SELECT * FROM prompt_suggestions WHERE id = ? AND project_id = ?').get(suggestionId, ctx.projectId);
  if (!row) throw createError('NOT_FOUND_SUGGESTION', { message: `优化建议不存在: ${suggestionId}` });
  return { ...(safeJson(row.payload_json) ?? {}), contentHash: row.content_hash, status: row.status };
}

export function buildSuggestionMessages({ base, stats, focus }) {
  const means = stats
    .map((item) => `- ${item.name}（${item.id}）：均值 ${item.mean == null ? '不可用' : item.mean.toFixed(3)}，规则失败 ${item.failedRules.map((rule) => `${rule.type}:${rule.value ?? ''}×${rule.count}`).join('、') || '无'}`)
    .join('\n');
  const evidence = stats
    .flatMap((item) =>
      item.lowTrials.slice(0, 2).map(
        (trial) => `- [${item.name}] 得分 ${trial.score.toFixed(3)}\n输入：${preview(trial.input)}\n输出：${preview(trial.output)}`,
      ),
    )
    .join('\n\n');
  return [
    {
      role: 'system',
      content:
        '你是严格的提示词诊断专家。只依据给定的运行证据提出可执行建议，不得改写或输出提示词全文。每条建议必须包含问题、证据依据、具体改法和预期影响。只输出 JSON：{"suggestions":[{"priority":"high|medium|low","dimension":"维度id","issue":"问题","suggestion":"具体改法","expectedImpact":"预期影响"}]}。',
    },
    {
      role: 'user',
      content: `当前提示词（分支 ${base.label}，v${base.versionNumber}）：
---
${base.content}
---

维度均值与规则失败：
${means}

低分证据：
${evidence || '（无）'}

${focus ? `额外关注：${focus}` : '请优先处理得分最低且证据最明确的维度。'}
建议控制在 1—5 条，不要重复。`,
    },
  ];
}

export function parseSuggestionResponse(text, { stats, maxSuggestions = DEFAULT_SUGGESTIONS }) {
  const raw = String(text ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw createError('PROVIDER_INVALID_REQUEST', { message: '优化建议模型未返回 JSON。' });
  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw createError('PROVIDER_INVALID_REQUEST', { message: `优化建议 JSON 解析失败: ${error.message}` });
  }
  if (!Array.isArray(parsed.suggestions)) {
    throw createError('PROVIDER_INVALID_REQUEST', { message: '优化建议返回缺少 suggestions 数组。' });
  }
  const byId = new Map(stats.map((item) => [item.id, item]));
  const suggestions = [];
  for (const item of parsed.suggestions) {
    if (!item || typeof item !== 'object') continue;
    const issue = String(item.issue ?? '').trim();
    const suggestion = String(item.suggestion ?? '').trim();
    if (!issue || !suggestion) continue;
    const dimensionId = typeof item.dimension === 'string' ? item.dimension : null;
    const stat = dimensionId ? byId.get(dimensionId) : null;
    const priority = ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium';
    suggestions.push({
      priority,
      dimension: dimensionId,
      dimensionName: stat?.name ?? null,
      issue,
      suggestion,
      expectedImpact: item.expectedImpact ? String(item.expectedImpact) : null,
      evidence: stat ? evidenceFrom(stat) : [],
    });
    if (suggestions.length >= clampMax(maxSuggestions)) break;
  }
  if (!suggestions.length) throw createError('PROVIDER_INVALID_REQUEST', { message: '优化建议为空或缺少问题/改法。' });
  return suggestions;
}

function requireFinishedRun(ctx, runId) {
  const run = ctx.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) throw createError('NOT_FOUND_RUN', { message: `运行不存在: ${runId}` });
  if (run.status === 'queued' || run.status === 'running' || run.status === 'cancel_requested') {
    throw createError('STATE_INVALID_TRANSITION', { message: '运行尚未结束，暂时没有完整证据可用于优化建议。' });
  }
  return run;
}

function lowestVariant(ctx, runId) {
  const row = ctx.db
    .prepare(
      `SELECT t.variant_version_id
       FROM trials t JOIN evaluations e ON e.trial_id = t.id
       WHERE t.run_id = ? AND t.comparison_eligible = 1 AND e.status = 'completed' AND e.overall_score IS NOT NULL
       GROUP BY t.variant_version_id
       ORDER BY AVG(e.overall_score) ASC, t.variant_version_id ASC
       LIMIT 1`,
    )
    .get(runId);
  if (!row) throw createError('STATE_EVIDENCE_MISSING', { message: '该运行没有可比的已评估 Trial，无法生成优化建议。' });
  return row.variant_version_id;
}

function getBaseVersion(ctx, versionId, runId) {
  const version = getPromptVersion(ctx, versionId);
  const used = ctx.db.prepare('SELECT 1 FROM trials WHERE run_id = ? AND variant_version_id = ? LIMIT 1').get(runId, versionId);
  if (!used) throw createError('VALIDATION_INVALID_REQUEST', { message: '所选提示词版本未参与该运行，证据不可比。' });
  return version;
}

function collectDimensionStats(ctx, runId, baseVersionId, dimensions) {
  const rows = ctx.db
    .prepare(
      `SELECT t.id AS trial_id, t.output_json, c.input_json, e.scores_json
       FROM trials t
       JOIN evaluations e ON e.trial_id = t.id
       LEFT JOIN cases c ON c.id = t.case_version_id
       WHERE t.run_id = ? AND t.comparison_eligible = 1 AND e.status = 'completed' AND t.variant_version_id = ?
       ORDER BY e.overall_score ASC, t.id ASC`,
    )
    .all(runId, baseVersionId);
  return dimensions.map((dimension) => {
    const values = [];
    const ruleCounts = new Map();
    const candidates = [];
    for (const row of rows) {
      const scores = safeJson(row.scores_json) ?? {};
      const value = scores.dimensions?.[dimension.id];
      if (typeof value === 'number') {
        values.push(value);
        candidates.push({
          trialId: row.trial_id,
          input: safeJson(row.input_json),
          output: safeJson(row.output_json),
          score: value,
        });
      }
      for (const rule of scores.details?.[dimension.id]?.rules ?? []) {
        if (rule?.passed === false) {
          const key = `${rule.type}:${typeof rule.value === 'object' ? JSON.stringify(rule.value) : (rule.value ?? '')}`;
          const current = ruleCounts.get(key) ?? { type: rule.type, value: rule.value ?? null, count: 0 };
          current.count++;
          ruleCounts.set(key, current);
        }
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    return {
      id: dimension.id,
      name: dimension.name,
      weight: dimension.weight,
      mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      failedRules: [...ruleCounts.values()].sort((a, b) => b.count - a.count),
      candidates,
      lowTrials: candidates.slice(0, 2),
    };
  });
}

function overallStats(ctx, runId, baseVersionId) {
  const row = ctx.db
    .prepare(
      `SELECT AVG(e.overall_score) AS mean, COUNT(*) AS count
       FROM trials t JOIN evaluations e ON e.trial_id = t.id
       WHERE t.run_id = ? AND t.comparison_eligible = 1 AND e.status = 'completed' AND e.overall_score IS NOT NULL AND t.variant_version_id = ?`,
    )
    .get(runId, baseVersionId);
  return { trialCount: Number(row?.count ?? 0), meanScore: row?.mean ?? null };
}

function buildSummary(stats, overall) {
  return {
    trialCount: overall.trialCount,
    meanScore: round3(overall.meanScore),
    dimensions: stats.map((item) => ({
      id: item.id,
      name: item.name,
      mean: round3(item.mean),
      failedRules: item.failedRules.slice(0, 3),
    })),
  };
}

function estimateSuggestionCost(modelConfig) {
  const pricing = modelConfig.pricing;
  if (!pricing) {
    return { amount: null, currency: null, completeness: 'unknown', note: '模型价格未知，实际成本以 Attempt 记录为准，不按 0 计。' };
  }
  if (pricing.unit === 'per_request' && pricing.perRequest != null) {
    return { amount: String(Number((Number(pricing.perRequest) * 1).toFixed(10))), currency: pricing.currency, completeness: 'complete' };
  }
  return { amount: null, currency: pricing.currency ?? null, completeness: 'usage_based', note: '按 Token 计价的模型无法在生成前精确预估。' };
}

function mockSuggestions(stats, limit) {
  const ranked = stats.filter((item) => item.mean != null).sort((a, b) => a.mean - b.mean);
  const targets = ranked.filter((item) => item.mean < TARGET_SCORE).slice(0, limit);
  const selected = targets.length ? targets : ranked.slice(0, 1);
  const suggestions = selected.map((stat) => ({
    priority: stat.mean < 0.5 ? 'high' : stat.mean < 0.75 ? 'medium' : 'low',
    dimension: stat.id,
    dimensionName: stat.name,
    issue: `「${stat.name}」平均分为 ${stat.mean.toFixed(3)}，${stat.mean < TARGET_SCORE ? `低于目标线 ${TARGET_SCORE}` : '未发现明显低分维度'}。`,
    suggestion: suggestionFor(stat),
    expectedImpact: `提升「${stat.name}」维度得分，并减少同类低分用例。`,
    evidence: evidenceFrom(stat),
  }));
  if (!suggestions.length) {
    suggestions.push({
      priority: 'low',
      dimension: null,
      dimensionName: null,
      issue: '当前运行没有可用于定位问题的维度分数。',
      suggestion: '补充可判定的评分规则或启用 judge，再重新运行以获取可执行建议。',
      expectedImpact: '提升证据完整度',
      evidence: [],
    });
  }
  return suggestions;
}

function suggestionFor(stat) {
  const rule = stat.failedRules[0];
  if (!rule) return `针对「${stat.name}」补充可验证的输出约束，并在回答前核对输入中的关键事实。`;
  const value = typeof rule.value === 'object' ? JSON.stringify(rule.value) : rule.value;
  switch (rule.type) {
    case 'contains':
      return `在提示词中明确要求回答覆盖「${value}」相关内容，并给出输出示例。`;
    case 'not_contains':
      return `在提示词中增加禁止性约束，避免输出「${value}」。`;
    case 'min_length':
      return `补充最小内容要求，确保回答不少于 ${value} 个字符，并说明必须包含的要点。`;
    case 'max_length':
      return `补充简洁性要求，将回答限制在 ${value} 个字符以内，优先保留结论。`;
    case 'regex':
      return `明确输出格式，确保符合正则 /${value}/，并提供格式示例。`;
    case 'json_valid':
      return '要求输出合法 JSON，并在提示词中列出必填字段与示例结构。';
    case 'equals':
      return '对齐参考答案的格式与措辞，补充输出模板或判定标准。';
    default:
      return `针对「${stat.name}」补充可验证的输出约束，并给出正反例。`;
  }
}

function evidenceFrom(stat) {
  return stat.lowTrials.map((trial) => ({
    trialId: trial.trialId,
    casePreview: preview(trial.input),
    score: Math.round(trial.score * 1000) / 1000,
    outputPreview: preview(trial.output),
  }));
}

function resolveModel(ctx, ref) {
  if (!ref) throw createError('VALIDATION_INVALID_REQUEST', { message: '请选择用于生成优化建议的模型。' });
  try {
    return getModelConfigVersion(ctx, ref);
  } catch (error) {
    if (error.code !== 'NOT_FOUND_MODEL') throw error;
    return findModelByName(ctx, ref);
  }
}

function clampMax(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return DEFAULT_SUGGESTIONS;
  return Math.min(MAX_SUGGESTIONS, number);
}

function preview(value) {
  if (value == null) return '（空）';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function round3(value) {
  return value === null || value === undefined ? null : Math.round(Number(value) * 1000) / 1000;
}

function safeJson(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
