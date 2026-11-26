import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createError } from './errors.js';
import { hashJson, hashText } from './hash.js';
import { ulid } from './ids.js';
import { nowIso } from './time.js';
import { putObject, getObject } from './objects.js';
import { computeUsageCost, addAmounts, formatAmount, getModelConfigVersion } from './models.js';
import { runSummaryForReport } from './run.js';
import { loadSnapshot } from './spec.js';
import { evaluationVersionForRun } from '../eval/engine.js';
import { normalizedWeights } from '../eval/profile.js';
import { toScaleScore } from '../eval/rules.js';
import { recordAudit } from './audit.js';
import { projectSettings } from './project-admin.js';
import { SERVER_VERSION } from '../version.js';

const REQUIRED_SECTIONS = ['summary', 'snapshot', 'method', 'results', 'evidence', 'failures', 'cost', 'uncertainty', 'limitations'];

/** 默认脱敏规则：鉴权头、常见密钥前缀与键值赋值。 */
const BASE_REDACTIONS = [
  { id: 'authorization', pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, replacement: '$1 [REDACTED]' },
  { id: 'api_key', pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: '[REDACTED]' },
  {
    id: 'credential_assignment',
    pattern: /\b(api[_-]?key|secret|password|token)\s*[:=]\s*["']?[^\s"',}]+/gi,
    replacement: '$1=[REDACTED]',
  },
];

/**
 * 报告脱敏：始终移除鉴权头与常见密钥，再按项目配置应用用户敏感字段。
 * 用户字段支持字面量或 `regex:` 前缀的正则。返回替换后的正文与实际生效规则。
 */
export function redactMarkdown(markdown, sensitiveFields = []) {
  let text = String(markdown ?? '');
  const applied = new Set(['credentialRef']);
  for (const rule of BASE_REDACTIONS) {
    const before = text;
    text = text.replace(rule.pattern, rule.replacement);
    if (text !== before) applied.add(rule.id);
  }
  for (const field of sensitiveFields ?? []) {
    const raw = String(field ?? '').trim();
    if (!raw) continue;
    if (raw.startsWith('regex:')) {
      try {
        const pattern = new RegExp(raw.slice('regex:'.length), 'g');
        text = text.replace(pattern, '[REDACTED]');
        applied.add(`regex:${raw.slice('regex:'.length)}`);
      } catch {
        /* 非法正则已在设置校验阶段阻断，这里静默跳过 */
      }
      continue;
    }
    text = text.split(raw).join('[REDACTED]');
    applied.add(`field:${raw}`);
  }
  return { text, applied: [...applied] };
}

export const DEFAULT_TEMPLATE = buildTemplate();

function buildTemplate() {
  const base = {
    schema: 'promptlens.report-template/v1',
    templateVersionId: 'tpl-standard-v1',
    name: '标准实验报告',
    versionNumber: 1,
    language: 'zh-CN',
    outputFormat: 'markdown',
    sections: [
      { id: 'summary', title: '运行摘要', required: true, order: 0 },
      { id: 'snapshot', title: '实验快照', required: true, order: 1 },
      { id: 'method', title: '评估方法', required: true, order: 2 },
      { id: 'results', title: '分维度结果', required: true, order: 3 },
      { id: 'evidence', title: '逐用例证据', required: true, order: 4 },
      { id: 'failures', title: '失败与无效输出', required: true, order: 5 },
      { id: 'cost', title: '成本与耗时', required: true, order: 6 },
      { id: 'uncertainty', title: '不确定性', required: true, order: 7 },
      { id: 'limitations', title: '限制与建议', required: true, order: 8 },
    ],
    variables: [
      { name: 'run_summary', source: 'run_summary', required: true },
      { name: 'snapshot_hash', source: 'snapshot', required: true },
      { name: 'evaluation_profile', source: 'evaluation_profile', required: true },
      { name: 'trial_matrix', source: 'trial_matrix', required: true },
      { name: 'failure_list', source: 'failure_list', required: true },
      { name: 'cost_summary', source: 'cost_summary', required: true },
      { name: 'uncertainty', source: 'uncertainty', required: true },
    ],
  };
  return { ...base, contentHash: hashJson(base) };
}

export function validateTemplate(template) {
  const errors = [];
  if (template?.schema !== 'promptlens.report-template/v1') errors.push('schema 必须是 promptlens.report-template/v1');
  if (template?.outputFormat !== 'markdown') errors.push('V1 仅支持 markdown 输出');
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(String(template?.language ?? ''))) errors.push('language 格式非法');
  if (template?.language !== 'zh-CN') errors.push(`当前版本仅支持 zh-CN 模板语言，收到 ${template?.language}`);
  const sections = Array.isArray(template?.sections) ? template.sections : [];
  for (const id of REQUIRED_SECTIONS) {
    const section = sections.find((item) => item.id === id);
    if (!section || section.required !== true) errors.push(`缺少必备章节或 required=true: ${id}`);
  }
  const allowed = new Set([...REQUIRED_SECTIONS, 'methodology_notes']);
  for (const section of sections) {
    if (!allowed.has(section.id)) errors.push(`未知章节: ${section.id}`);
    if (!String(section.title ?? '').trim()) errors.push(`章节 ${section.id} 缺少标题`);
  }
  const allowedSources = new Set(['run_summary', 'snapshot', 'evaluation_profile', 'trial_matrix', 'failure_list', 'cost_summary', 'uncertainty', 'user_note']);
  for (const variable of template?.variables ?? []) {
    if (!allowedSources.has(variable.source)) errors.push(`未知变量来源: ${variable.source}`);
  }
  if (errors.length) {
    throw createError('VALIDATION_REPORT_TEMPLATE_INVALID', { message: '报告模板校验失败。', details: { errors } });
  }
  return template;
}

export function generateReport(ctx, runId, options = {}) {
  const template = options.template ?? DEFAULT_TEMPLATE;
  validateTemplate(template);
  const { run, data, snapshot, attempts } = runSummaryForReport(ctx, runId);
  if (!['completed', 'completed_with_errors', 'canceled', 'failed'].includes(run.status)) {
    throw createError('STATE_INVALID_TRANSITION', {
      message: `运行尚未结束（${run.status}），不能生成最终报告。`,
      remediation: '先等待运行结束，或取消运行后重试。',
    });
  }
  const context = buildReportContext(ctx, { run, data, snapshot, attempts });
  const redaction = redactMarkdown(renderMarkdown(template, context), projectSettings(ctx).sensitiveFields ?? []);
  const markdown = redaction.text;
  const reportId = ulid();
  const contentHash = hashText(markdown);
  const exportToExports = options.exportToExports !== false;
  const baseDir = exportToExports ? join('exports', 'reports') : join('.promptlens', 'reports');
  const relativePath = join(baseDir, runId, `report-${reportId}.md`).split('\\').join('/');
  const absolutePath = join(ctx.root, relativePath);
  mkdirSync(join(ctx.root, baseDir, runId), { recursive: true });
  writeFileSync(absolutePath, markdown, 'utf8');
  putObject(ctx.root, markdown);

  const evaluationVersion = evaluationVersionForRun(ctx, runId);
  const evaluationVersionIds = evaluationVersion ? [evaluationVersion.id] : [];
  const generatedAt = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO reports(id, project_id, run_id, template_version_id, snapshot_hash, evaluation_version_ids_json, format, language, status, content_hash, path, generated_at, evidence_state, redactions_json, error_json, template_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      reportId,
      ctx.projectId,
      runId,
      template.templateVersionId,
      run.snapshot_hash,
      JSON.stringify(evaluationVersionIds),
      'markdown',
      template.language,
      'generated',
      contentHash,
      relativePath,
      generatedAt,
      'present',
      JSON.stringify(redaction.applied),
      null,
      JSON.stringify(template),
    );

  recordAudit(ctx, 'report.generated', { reportId, runId, templateVersionId: template.templateVersionId, contentHash });

  return {
    reportId,
    runId,
    templateVersionId: template.templateVersionId,
    snapshotHash: run.snapshot_hash,
    evaluationVersionIds,
    format: 'markdown',
    language: template.language,
    status: 'generated',
    contentHash,
    path: relativePath,
    generatedAt,
    evidenceState: 'present',
    redactions: redaction.applied,
    exported: exportToExports,
    warnings: context.warnings,
    summary: context.summary,
  };
}

export function listReports(ctx, runId = null) {
  const rows = runId
    ? ctx.db.prepare('SELECT * FROM reports WHERE run_id = ? ORDER BY generated_at DESC').all(runId)
    : ctx.db.prepare('SELECT * FROM reports ORDER BY generated_at DESC').all();
  return rows.map(mapReport);
}

export function getReport(ctx, reportId) {
  const row = ctx.db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
  if (!row) throw createError('NOT_FOUND_REPORT', { message: `报告不存在: ${reportId}` });
  const report = mapReport(row);
  let markdown = null;
  if (report.status === 'generated' && row.path) {
    const absolute = join(ctx.root, row.path);
    if (existsSync(absolute)) markdown = readFileSync(absolute, 'utf8');
  }
  return { report, markdown };
}

export function exportReport(ctx, reportId, targetPath) {
  const { report, markdown } = getReport(ctx, reportId);
  if (report.status !== 'generated' || !markdown) {
    throw createError('NOT_FOUND_REPORT', { message: '报告内容不可用，无法导出。' });
  }
  let target = resolve(targetPath);
  if (!target.endsWith('.md')) {
    target = join(target, `report-${reportId}.md`);
  }
  if (existsSync(target)) {
    const existing = readFileSync(target, 'utf8');
    if (hashText(existing) !== report.contentHash) {
      throw createError('STATE_INVALID_TRANSITION', {
        message: '目标文件已存在且内容不同，拒绝静默覆盖。',
        details: { target },
        remediation: '指定新的输出路径或先备份现有文件。',
      });
    }
    return { reportId, path: target, unchanged: true, contentHash: report.contentHash };
  }
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, markdown, 'utf8');
  recordAudit(ctx, 'report.exported', { reportId, path: target, contentHash: report.contentHash, unchanged: false });
  return { reportId, path: target, unchanged: false, contentHash: report.contentHash };
}

function mapReport(row) {
  return {
    schema: 'promptlens.report/v1',
    reportId: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    templateVersionId: row.template_version_id,
    snapshotHash: row.snapshot_hash,
    evaluationVersionIds: JSON.parse(row.evaluation_version_ids_json ?? '[]'),
    format: row.format,
    language: row.language,
    status: row.status,
    ...(row.content_hash ? { contentHash: row.content_hash } : {}),
    ...(row.path ? { path: row.path } : {}),
    generatedAt: row.generated_at,
    ...(row.evidence_state ? { evidenceState: row.evidence_state } : {}),
    ...(row.redactions_json ? { redactions: JSON.parse(row.redactions_json) } : {}),
    ...(row.error_json ? { error: JSON.parse(row.error_json) } : {}),
    ...(row.template_json ? { template: JSON.parse(row.template_json) } : {}),
  };
}

function buildReportContext(ctx, { run, data, snapshot, attempts }) {
  const evalRows = ctx.db
    .prepare(
      `SELECT e.*, t.variant_version_id, t.model_config_version_id, t.case_version_id, t.repetition_index
       FROM evaluations e JOIN trials t ON t.id = e.trial_id WHERE t.run_id = ? ORDER BY e.created_at`,
    )
    .all(run.id);
  const evaluationByTrial = new Map(evalRows.map((row) => [row.trial_id, row]));

  const modelById = new Map(snapshot.models.map((model) => [model.modelConfigVersionId, model]));
  for (const model of snapshot.models) {
    for (const fallback of model.fallbackModels ?? []) modelById.set(fallback.modelConfigVersionId, fallback);
  }
  const variantById = new Map(snapshot.variants.map((variant) => [variant.promptVersionId, variant]));
  const caseById = new Map(snapshot.testSet.cases.map((item) => [item.caseVersionId, item]));

  const groups = new Map();
  const failures = [];
  const samples = [];
  const costs = { currency: null, known: 0, unknown: false, byModel: new Map(), latency: { total: 0, count: 0, samples: [] } };
  const dimensionIds = snapshot.evaluation.config.dimensions.map((dimension) => dimension.id);

  for (const trial of data.trials) {
    const variant = variantById.get(trial.variantVersionId);
    const model = modelById.get(trial.modelConfigVersionId);
    const key = `${variant?.label ?? '?'}::${model?.name ?? '?'}`;
    if (!groups.has(key)) groups.set(key, { variant: variant?.label ?? '?', model: model?.name ?? '?', trials: [] });
    const group = groups.get(key);
    group.trials.push(trial);

    if (trial.trialStatus === 'failed' || trial.trialStatus === 'canceled' || trial.outputValidity !== 'valid') {
      failures.push({
        trialId: trial.id,
        variant: variant?.label ?? '?',
        model: model?.name ?? '?',
        casePreview: preview(caseById.get(trial.caseVersionId)?.input),
        trialStatus: trial.trialStatus,
        outputValidity: trial.outputValidity,
        reasons: trial.ineligibilityReasons,
      });
    }
  }

  for (const attempt of attempts) {
    const model = modelById.get(attempt.actual_model_config_version_id);
    const usage = attempt.normalized_usage_json ? JSON.parse(attempt.normalized_usage_json) : {};
    const cost = computeUsageCost(usage, model?.pricing ?? null);
    if (cost.amount === null) costs.unknown = true;
    else {
      costs.known = Number(addAmounts(String(costs.known), cost.amount) ?? costs.known);
      costs.currency = cost.currency ?? costs.currency;
    }
    if (model) {
      const entry = costs.byModel.get(model.name) ?? { amount: 0, currency: null, requests: 0, unknown: false };
      entry.requests++;
      if (cost.amount === null) entry.unknown = true;
      else {
        entry.amount = Number(addAmounts(String(entry.amount), cost.amount) ?? entry.amount);
        entry.currency = cost.currency ?? entry.currency;
      }
      costs.byModel.set(model.name, entry);
    }
    if (attempt.started_at && attempt.finished_at) {
      const duration = new Date(attempt.finished_at) - new Date(attempt.started_at);
      costs.latency.total += duration;
      costs.latency.count++;
      costs.latency.samples.push(duration);
    }
  }

  const judgeCosts = { enabled: Boolean(snapshot.evaluation.config.judge?.enabled), model: null, calls: 0, known: 0, currency: null, unknown: false, meanConsistency: null, minConsistency: null };
  if (judgeCosts.enabled) {
    const judgeVersionId = snapshot.spec.evaluation.judgeModelConfigVersionId ?? null;
    let judgeModel = null;
    if (judgeVersionId) {
      try {
        judgeModel = getModelConfigVersion(ctx, judgeVersionId);
      } catch {
        judgeModel = null;
      }
    }
    judgeCosts.model = judgeModel?.name ?? null;
    const consistencyValues = [];
    for (const row of evalRows) {
      if (!row.scores_json) continue;
      const scores = JSON.parse(row.scores_json);
      if (typeof scores.judgeConsistency === 'number') consistencyValues.push(scores.judgeConsistency);
      const usages = Array.isArray(scores.judgeUsage) ? scores.judgeUsage : [];
      for (const usage of usages) {
        judgeCosts.calls++;
        const cost = computeUsageCost(usage, judgeModel?.pricing ?? null);
        if (cost.amount === null) judgeCosts.unknown = true;
        else {
          judgeCosts.known = Number(addAmounts(String(judgeCosts.known), cost.amount) ?? judgeCosts.known);
          judgeCosts.currency = cost.currency ?? judgeCosts.currency;
        }
      }
    }
    if (consistencyValues.length) {
      judgeCosts.meanConsistency = mean(consistencyValues);
      judgeCosts.minConsistency = Math.min(...consistencyValues);
    }
    if (judgeCosts.calls > 0) {
      if (judgeCosts.unknown) costs.unknown = true;
      else {
        costs.known = Number(addAmounts(String(costs.known), String(judgeCosts.known)) ?? costs.known);
        costs.currency = judgeCosts.currency ?? costs.currency;
      }
      const label = `${judgeModel?.name ?? 'judge'} (judge)`;
      const entry = costs.byModel.get(label) ?? { amount: 0, currency: null, requests: 0, unknown: false };
      entry.requests += judgeCosts.calls;
      if (judgeCosts.unknown) entry.unknown = true;
      else {
        entry.amount = Number(addAmounts(String(entry.amount), String(judgeCosts.known)) ?? entry.amount);
        entry.currency = judgeCosts.currency ?? entry.currency;
      }
      costs.byModel.set(label, entry);
    }
  }
  costs.judge = judgeCosts;

  const groupStats = [...groups.values()].map((group) => {
    const eligible = group.trials.filter((trial) => trial.comparisonEligible);
    const scores = eligible
      .map((trial) => evaluationByTrial.get(trial.id))
      .filter((row) => row && row.overall_score != null)
      .map((row) => Number(row.overall_score));
    const dimensionScores = {};
    for (const dimension of dimensionIds) {
      const values = eligible
        .map((trial) => evaluationByTrial.get(trial.id))
        .filter(Boolean)
        .map((row) => {
          const scoresJson = row.scores_json ? JSON.parse(row.scores_json) : null;
          return scoresJson?.dimensions?.[dimension];
        })
        .filter((value) => typeof value === 'number');
      dimensionScores[dimension] = values.length ? mean(values) : null;
    }
    return {
      variant: group.variant,
      model: group.model,
      total: group.trials.length,
      eligible: eligible.length,
      completed: group.trials.filter((trial) => trial.trialStatus === 'completed').length,
      outputValid: group.trials.filter((trial) => trial.outputValidity === 'valid').length,
      meanScore: scores.length ? mean(scores) : null,
      sd: scores.length > 1 ? stddev(scores) : null,
      ci95: scores.length > 1 ? 1.96 * (stddev(scores) / Math.sqrt(scores.length)) : null,
      dimensionScores,
    };
  });

  for (const group of groups.values()) {
    const eligible = group.trials.filter((trial) => trial.comparisonEligible);
    for (const trial of eligible.slice(0, 3)) {
      const output = data.outputs?.[trial.id];
      if (!output?.content) continue;
      samples.push({
        variant: group.variant,
        model: group.model,
        casePreview: preview(caseById.get(trial.caseVersionId)?.input),
        content: String(output.content).slice(0, 400),
        score: evaluationByTrial.get(trial.id)?.overall_score ?? null,
      });
    }
  }

  const weights = normalizedWeights(snapshot.evaluation.config.dimensions);
  const scale = snapshot.evaluation.config.scale ?? null;
  const dimensionMeta = snapshot.evaluation.config.dimensions.map((dimension) => ({
    id: dimension.id,
    name: dimension.name,
    weight: dimension.weight,
    normalizedWeight: weights.byDimension[dimension.id],
    gating: Boolean(dimension.gating),
    gate: dimension.gate ?? null,
    ruleCount: (dimension.rules ?? []).length,
  }));

  const warnings = [];
  const smallestN = groupStats.length ? Math.min(...groupStats.map((group) => group.eligible)) : 0;
  if (smallestN < 10) warnings.push({ code: 'SMALL_SAMPLE', message: `最小有效样本量为 ${smallestN}，区间估计不稳定，不应据此下强结论。` });
  if (costs.unknown) warnings.push({ code: 'PRICE_INCOMPLETE', message: '部分模型价格未知，成本合计不完整，未按 0 计入。' });
  if (snapshot.models.some((model) => model.providerType === 'mock')) warnings.push({ code: 'MOCK_PROVIDER', message: '运行使用了 mock 提供方，输出不代表真实模型质量。' });
  if (data.counts.fallbackUsed > 0) warnings.push({ code: 'FALLBACK_USED', message: `${data.counts.fallbackUsed} 个 Trial 使用了跨模型回退，已从对照中排除。` });
  if (snapshot.models.some((model) => (model.fallbackModelConfigVersionIds ?? []).length)) {
    warnings.push({ code: 'FALLBACK_CONFIGURED', message: '规格配置了故障转移，跨模型结果不可与原模型直接比较。' });
  }
  if (judgeCosts.enabled && judgeCosts.meanConsistency !== null && judgeCosts.meanConsistency < 0.75) {
    warnings.push({
      code: 'JUDGE_UNSTABLE',
      message: `评审模型多次重复评分的一致性偏低（均值 ${judgeCosts.meanConsistency.toFixed(3)}，最低 ${judgeCosts.minConsistency.toFixed(3)}），语义评审分数存在波动，建议提高重复次数或人工复核。`,
    });
  }

  const limitations = buildLimitations(snapshot, data, groupStats, costs);
  const summary = {
    runId: run.id,
    status: run.status,
    stopReason: run.stop_reason,
    snapshotHash: run.snapshot_hash,
    trialCount: data.counts.total,
    outputValidRate: data.counts.total ? data.counts.outputValid / data.counts.total : null,
    comparisonEligible: data.counts.comparisonEligible,
    variants: [...new Set(groupStats.map((group) => group.variant))],
    models: [...new Set(groupStats.map((group) => group.model))],
    caseCount: snapshot.testSet.cases.length,
    repetitions: snapshot.repetitions,
  };

  const conclusion = buildConclusion(groupStats, warnings);
  return { run, data, snapshot, scale, groupStats, dimensionMeta, failures, samples, costs, warnings, limitations, summary, conclusion, evaluationByTrial };
}

function buildConclusion(groupStats, warnings) {
  const scored = groupStats.filter((group) => group.meanScore != null).sort((a, b) => b.meanScore - a.meanScore);
  if (!scored.length) return { verdict: 'insufficient_evidence', text: '没有可比较的已完成评估 Trial，无法形成质量结论。' };
  if (scored.length === 1) return { verdict: 'insufficient_evidence', text: '只有一个分组产生有效评分，无法进行 A/B 对照。' };
  const best = scored[0];
  const second = scored[1];
  const gap = best.meanScore - second.meanScore;
  if (warnings.some((warning) => warning.code === 'SMALL_SAMPLE')) {
    return { verdict: 'insufficient_evidence', text: `当前最佳为 ${best.variant}/${best.model}（均值 ${best.meanScore.toFixed(3)}），但样本量不足，证据不足以支持明确优劣结论。` };
  }
  if (gap < 0.02) {
    return { verdict: 'no_meaningful_difference', text: `${best.variant}/${best.model} 与 ${second.variant}/${second.model} 差异小于 0.02，未观察到有意义的差别。` };
  }
  return { verdict: 'directional_support', text: `${best.variant}/${best.model} 在有效样本上领先 ${second.variant}/${second.model} ${gap.toFixed(3)}，方向性支持该分支，但不等于统计显著。` };
}

function buildLimitations(snapshot, data, groupStats, costs) {
  const items = [];
  if (snapshot.models.some((model) => model.providerType === 'mock')) items.push('运行包含 mock 提供方结果，只能验证流程与指标链路，不能代表真实模型表现。');
  if (snapshot.testSet.cases.length < 30) items.push(`测试集仅 ${snapshot.testSet.cases.length} 条用例，覆盖率有限；结论不应外推到未覆盖场景。`);
  if (groupStats.some((group) => group.eligible < 10)) items.push('部分分组有效样本少于 10，置信区间不稳定。');
  if (data.counts.fallbackUsed > 0) items.push('跨模型回退结果已排除出对照均值，可能降低有效样本。');
  if (costs.unknown) items.push('存在未知价格模型，成本合计不完整。');
  if (!snapshot.evaluation.config.judge?.enabled) items.push('本次评估仅使用确定性规则，未包含语义评审，可能低估表达质量差异。');
  items.push('规则通过率反映预设约束，不等同于人工质量判断；落地前建议人工抽检。');
  return items;
}

function renderMarkdown(template, context) {
  const sections = [...template.sections].sort((a, b) => a.order - b.order);
  const chunks = [];
  chunks.push(`# ${template.name}`);
  chunks.push(`> 报告模板：${template.templateVersionId} · 语言：${template.language} · 生成器：promptlens/${SERVER_VERSION}`);
  for (const section of sections) {
    const body = renderSection(section.id, context);
    chunks.push(`\n## ${section.title}\n`);
    chunks.push(body);
  }
  return `${chunks.join('\n')}\n`;
}

function renderSection(id, context) {
  switch (id) {
    case 'summary':
      return renderSummary(context);
    case 'snapshot':
      return renderSnapshot(context);
    case 'method':
      return renderMethod(context);
    case 'results':
      return renderResults(context);
    case 'evidence':
      return renderEvidence(context);
    case 'failures':
      return renderFailures(context);
    case 'cost':
      return renderCost(context);
    case 'uncertainty':
      return renderUncertainty(context);
    case 'limitations':
      return renderLimitations(context);
    default:
      return '_无内容_';
  }
}

function renderSummary(context) {
  const { summary, conclusion, data } = context;
  const lines = [
    `- 运行：\`${summary.runId}\`（${summary.status}${summary.stopReason ? `，停止原因 ${summary.stopReason}` : ''}）`,
    `- 快照：\`${summary.snapshotHash}\``,
    `- 计划：${summary.variants.join(' / ')} × ${summary.models.join(' / ')} × ${summary.caseCount} 用例 × ${summary.repetitions} 次重复`,
    `- Trial：${summary.trialCount}，其中有效输出 ${data.counts.outputValid}，可比较 ${summary.comparisonEligible}，fallback ${data.counts.fallbackUsed}`,
    `- 结论：${conclusion.text}`,
  ];
  return lines.join('\n');
}

function renderSnapshot(context) {
  const { snapshot, run } = context;
  const rows = snapshot.models.map((model) => `| ${model.name} | ${model.providerType} | ${model.modelId} | ${(model.fallbackModelConfigVersionIds ?? []).length} |`).join('\n');
  return [
    `- 快照哈希：\`${snapshot.hash}\``,
    `- 运行创建：${run.created_at}`,
    `- 测试集：${snapshot.testSet.name}（${snapshot.testSet.cases.length} 条，版本 \`${snapshot.testSet.testSetVersionId}\`）`,
    `- 执行参数：maxAttempts=${snapshot.execution.maxAttempts}，maxConcurrency=${snapshot.execution.maxConcurrency}，order=${snapshot.execution.order}`,
    '',
    '| 模型 | 提供方 | 模型 ID | 回退数 |',
    '| --- | --- | --- | --- |',
    rows,
    '',
    `凭据引用已脱敏（${'credentialRef'}），报告中不包含密钥值。`,
  ].join('\n');
}

function renderMethod(context) {
  const { snapshot, dimensionMeta, scale } = context;
  const rows = dimensionMeta
    .map(
      (dimension) =>
        `| ${dimension.name}（\`${dimension.id}\`） | ${dimension.weight} | ${((dimension.normalizedWeight ?? 0) * 100).toFixed(1)}% | ${dimension.ruleCount} | ${dimension.gating ? `是，≥${formatScaleValue(dimension.gate ?? 0.5, scale)}` : '否'} |`,
    )
    .join('\n');
  const anchors = Object.entries(scale?.anchors ?? {})
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([level, text]) => `| ${level} | ${text} |`)
    .join('\n');
  const judge = snapshot.evaluation.config.judge?.enabled
    ? `启用，重复 ${snapshot.spec.evaluation.judgeRepetitions ?? 1} 次，模型版本 \`${snapshot.spec.evaluation.judgeModelConfigVersionId ?? '未指定'}\``
    : '未启用（仅规则评估）';
  const lines = [
    `- 评分方案：${snapshot.evaluation.name}（\`${snapshot.evaluation.profileVersionId}\`，哈希 \`${snapshot.evaluation.contentHash}\`）`,
    `- 评分刻度：${scale ? `${scale.min}—${scale.max}（报告按刻度换算展示，内部比较使用 0—1 归一化口径）` : '0—1 小数'}`,
    `- LLM 评审：${judge}`,
    '',
    '| 维度 | 原始权重 | 归一化权重 | 规则数 | 硬门槛 |',
    '| --- | --- | --- | --- | --- |',
    rows,
  ];
  if (anchors) {
    lines.push('', '### 分值锚点', '', '| 分值 | 锚点 |', '| --- | --- |', anchors);
  }
  lines.push('', '维度分数 = 规则通过率（与可选的评审分数取平均）；总分 = 维度加权平均。无效输出不参与均值。');
  return lines.join('\n');
}

function renderResults(context) {
  const { groupStats, dimensionMeta, scale } = context;
  if (!groupStats.length) return '_无结果_';
  const header = ['分支', '模型', 'Trial', '有效', '可比较', '均值', '95% CI', ...dimensionMeta.map((dimension) => dimension.name)];
  const rows = groupStats.map((group) =>
    [
      group.variant,
      group.model,
      group.total,
      group.outputValid,
      group.eligible,
      formatScaleValue(group.meanScore, scale),
      group.ci95 == null ? '—' : formatScaleValue(group.ci95, scale, true),
      ...dimensionMeta.map((dimension) => formatScaleValue(group.dimensionScores[dimension.id], scale)),
    ].join(' | '),
  );
  const note = scale
    ? `\n\n> 分数已按 ${scale.min}—${scale.max} 刻度换算展示；统计口径与加权计算仍基于 0—1 归一化分数。`
    : '';
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row} |`)].join('\n') + note;
}

function renderEvidence(context) {
  if (!context.samples.length) return '_没有可展示的有效样本。_';
  return context.samples
    .map(
      (sample) =>
        `**${sample.variant} / ${sample.model}** · 用例：${sample.casePreview} · 分数：${sample.score == null ? '—' : Number(sample.score).toFixed(3)}\n\n> ${sample.content.replace(/\n/g, '\n> ')}`,
    )
    .join('\n\n');
}

function renderFailures(context) {
  const { failures, data } = context;
  if (!failures.length) return '没有失败或无效输出的 Trial。';
  const rows = failures.slice(0, 50).map(
    (failure) => `| ${failure.variant} | ${failure.model} | ${failure.casePreview} | ${failure.trialStatus} | ${failure.outputValidity} | ${failure.reasons.join(', ') || '—'} |`,
  );
  const counts = data.counts;
  return [
    `- 失败 ${counts.failed}，取消 ${counts.canceled}，无效输出 ${counts.outputInvalid}，fallback ${counts.fallbackUsed}`,
    '',
    '| 分支 | 模型 | 用例 | 执行状态 | 输出有效性 | 不可比原因 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    failures.length > 50 ? `\n（仅展示前 50 条，共 ${failures.length} 条。）` : '',
  ].join('\n');
}

function renderCost(context) {
  const { costs, snapshot } = context;
  const byModel = [...costs.byModel.entries()]
    .map(([name, entry]) => `| ${name} | ${entry.requests} | ${entry.unknown ? '未知' : `${entry.amount.toFixed(6)} ${entry.currency ?? ''}`} |`)
    .join('\n');
  const avgLatency = costs.latency.count ? costs.latency.total / costs.latency.count : null;
  const p50 = percentile(costs.latency.samples, 50);
  const p95 = percentile(costs.latency.samples, 95);
  const priceNote = snapshot.models.every((model) => model.pricing)
    ? '全部模型价格已知。'
    : '存在未知价格模型，成本合计不完整；未知价格不按 0 处理。';
  const judge = costs.judge;
  const judgeLine = judge?.enabled
    ? `- 评审模型（judge）：${judge.calls} 次调用，成本 ${judge.unknown ? '不完整（价格未知）' : `${judge.known.toFixed(6)} ${judge.currency ?? ''}`}`
    : '- 评审模型（judge）：未启用';
  return [
    `- 总成本：${costs.unknown ? '不完整（含未知价格）' : `${costs.known.toFixed(6)} ${costs.currency ?? ''}`}`,
    judgeLine,
    `- 平均请求耗时：${avgLatency == null ? '未知' : `${Math.round(avgLatency)} ms`}（P50 ${p50 == null ? '—' : `${p50} ms`}，P95 ${p95 == null ? '—' : `${p95} ms`}，样本 ${costs.latency.count}）`,
    `- 价格完整度：${priceNote}`,
    '',
    '| 模型 | 请求数 | 成本 |',
    '| --- | --- | --- |',
    byModel || '| — | 0 | — |',
  ].join('\n');
}

function renderUncertainty(context) {
  const { groupStats, summary, costs } = context;
  const rows = groupStats
    .map((group) => `| ${group.variant} | ${group.model} | ${group.eligible} | ${group.sd == null ? '—' : group.sd.toFixed(3)} | ${group.ci95 == null ? '—' : `±${group.ci95.toFixed(3)}`} |`)
    .join('\n');
  const notes = [];
  if (groupStats.some((group) => group.eligible < 10)) notes.push('有效样本 < 10 的分组区间估计不可靠。');
  if (summary.repetitions < 2) notes.push('仅运行一次，未估计模型随机波动。');
  const judge = costs.judge;
  if (judge?.enabled) {
    if (judge.calls === 0) notes.push('评分方案启用了 judge，但没有记录到评审调用（可能全部失败或规格未指定 judge 模型）。');
    else if (judge.meanConsistency === null) notes.push('评审仅重复一次，无法估计评审模型自身的评分一致性；如需波动估计请提高重复次数。');
    else {
      notes.push(`评审模型评分一致性均值 ${judge.meanConsistency.toFixed(3)}，最低 ${judge.minConsistency.toFixed(3)}（1 表示多次重复完全一致）。`);
      if (judge.meanConsistency < 0.75) notes.push('评审一致性偏低，语义分数存在明显波动，结论应结合人工复核。');
    }
  }
  return [
    `- 用例数：${summary.caseCount}，重复次数：${summary.repetitions}`,
    `- 本报告不声明统计显著性；95% CI 为大样本正态近似，仅供参考。`,
    '',
    '| 分支 | 模型 | 有效样本 | 标准差 | 95% CI |',
    '| --- | --- | --- | --- | --- |',
    rows,
    notes.length ? `\n${notes.map((note) => `- ${note}`).join('\n')}` : '',
  ].join('\n');
}

function renderLimitations(context) {
  const lines = context.limitations.map((item) => `- ${item}`);
  const warnings = context.warnings.map((warning) => `- [${warning.code}] ${warning.message}`);
  return [...lines, warnings.length ? '\n运行告警：' : '', ...warnings].filter(Boolean).join('\n');
}

function formatScaleValue(value, scale, delta = false) {
  if (value == null) return '—';
  if (scale) {
    const converted = toScaleScore(value, scale);
    return delta ? `±${(Number(converted) - Number(scale.min)).toFixed(1)}` : Number(converted).toFixed(1);
  }
  return delta ? `±${Number(value).toFixed(3)}` : Number(value).toFixed(3);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 最近秩百分位（nearest-rank），样本少时也能给出稳定读数。 */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]);
}

function stddev(values) {
  if (values.length < 2) return null;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function preview(value) {
  if (value === null || value === undefined) return '（空）';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export { REQUIRED_SECTIONS, formatAmount };
