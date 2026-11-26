import { createError } from './errors.js';
import { loadSnapshot } from './spec.js';
import { computeUsageCost, addAmounts, formatAmount, getModelConfigVersion } from './models.js';
import { getRun } from './run.js';
import { listEvaluations } from '../eval/engine.js';
import { normalizedWeights } from '../eval/profile.js';

const RUN_SELECT = `
SELECT r.*,
  (SELECT COUNT(*) FROM trials t WHERE t.run_id = r.id) AS total,
  (SELECT COUNT(*) FROM trials t WHERE t.run_id = r.id AND t.trial_status = 'queued') AS queued,
  (SELECT COUNT(*) FROM trials t WHERE t.run_id = r.id AND t.trial_status = 'running') AS running,
  (SELECT COUNT(*) FROM trials t WHERE t.run_id = r.id AND t.trial_status = 'retrying') AS retrying,
  (SELECT COUNT(*) FROM trials t WHERE t.run_id = r.id AND t.trial_status = 'completed') AS completed,
  (SELECT COUNT(*) FROM trials t WHERE t.run_id = r.id AND t.trial_status = 'canceled') AS canceled,
  (SELECT COUNT(*) FROM trials t WHERE t.run_id = r.id AND t.trial_status = 'aborted_unknown') AS aborted_unknown,
  (SELECT COUNT(*) FROM trials t WHERE t.run_id = r.id AND t.trial_status IN ('failed','aborted_unknown')) AS failed,
  (SELECT COUNT(*) FROM trials t WHERE t.run_id = r.id AND t.output_validity = 'valid') AS output_valid,
  (SELECT COUNT(*) FROM trials t WHERE t.run_id = r.id AND t.output_validity NOT IN ('valid','not_available')) AS output_invalid,
  (SELECT COUNT(*) FROM trials t WHERE t.run_id = r.id AND t.comparison_eligible = 1) AS eligible,
  (SELECT COUNT(*) FROM trials t WHERE t.run_id = r.id AND EXISTS (
     SELECT 1 FROM attempts a WHERE a.trial_id = t.id AND a.fallback_used = 1)) AS fallback_used,
  (SELECT COALESCE(SUM(json_extract(t.output_json, '$.cost.amount')), 0) FROM trials t
     WHERE t.run_id = r.id AND json_extract(t.output_json, '$.cost.amount') IS NOT NULL) AS cost_amount,
  (SELECT COUNT(*) FROM trials t WHERE t.run_id = r.id AND t.output_json IS NOT NULL
     AND json_extract(t.output_json, '$.cost.amount') IS NULL) AS cost_unknown_count,
  (SELECT AVG(e.overall_score) FROM evaluations e JOIN trials t ON t.id = e.trial_id
     WHERE t.run_id = r.id AND t.comparison_eligible = 1 AND e.overall_score IS NOT NULL) AS mean_score
FROM runs r
`;

export function listRuns(ctx, { status = null, from = null, to = null, modelConfigVersionId = null, variantVersionId = null, limit = 20, offset = 0 } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('r.status = ?');
    params.push(status);
  }
  if (from) {
    clauses.push('r.created_at >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('r.created_at <= ?');
    params.push(to);
  }
  if (modelConfigVersionId) {
    clauses.push('EXISTS (SELECT 1 FROM trials t WHERE t.run_id = r.id AND t.model_config_version_id = ?)');
    params.push(modelConfigVersionId);
  }
  if (variantVersionId) {
    clauses.push('EXISTS (SELECT 1 FROM trials t WHERE t.run_id = r.id AND t.variant_version_id = ?)');
    params.push(variantVersionId);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const total = Number(ctx.db.prepare(`SELECT COUNT(*) AS n FROM runs r${where}`).get(...params).n);
  const rows = ctx.db
    .prepare(`${RUN_SELECT}${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`)
    .all(...params, clampLimit(limit), Math.max(0, offset));
  return {
    total,
    limit: clampLimit(limit),
    offset: Math.max(0, offset),
    runs: rows.map(mapRunRow),
  };
}

function mapRunRow(row) {
  const costAmount = row.cost_amount == null ? null : String(row.cost_amount);
  return {
    runId: row.id,
    projectId: row.project_id,
    snapshotId: row.snapshot_id,
    snapshotHash: row.snapshot_hash,
    status: row.status,
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    ...(row.stop_reason ? { stopReason: row.stop_reason } : {}),
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    updatedAt: row.updated_at,
    counts: {
      total: Number(row.total),
      queued: Number(row.queued),
      running: Number(row.running),
      retrying: Number(row.retrying),
      completed: Number(row.completed),
      canceled: Number(row.canceled),
      abortedUnknown: Number(row.aborted_unknown),
      failed: Number(row.failed),
      outputValid: Number(row.output_valid),
      outputInvalid: Number(row.output_invalid),
      comparisonEligible: Number(row.eligible),
      fallbackUsed: Number(row.fallback_used),
    },
    cost: {
      amount: costAmount,
      unknownCount: Number(row.cost_unknown_count),
      complete: Number(row.cost_unknown_count) === 0,
    },
    meanScore: row.mean_score == null ? null : Number(row.mean_score),
  };
}

/** 运行详情：附分支/用例/模型标签与评估结果，供监控与比较页直接渲染。 */
export function runBundle(ctx, runId, { trialLimit = 200, trialOffset = 0, includeOutputs = false } = {}) {
  const data = getRun(ctx, runId, { includeOutputs });
  const runRow = ctx.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  const snapshot = loadSnapshot(ctx, runRow.snapshot_id);
  const limitedTrials = data.trials.slice(trialOffset, trialOffset + trialLimit);
  const variants = Object.fromEntries(
    snapshot.variants.map((variant) => [
      variant.promptVersionId,
      {
        label: variant.label,
        promptName: variant.promptName,
        variantLabel: variant.variantLabel,
        versionNumber: variant.versionNumber,
        contentHash: variant.contentHash,
      },
    ]),
  );
  const models = {};
  for (const model of snapshot.models) {
    models[model.modelConfigVersionId] = {
      name: model.name,
      providerType: model.providerType,
      modelId: model.modelId,
      pricing: model.pricing ?? null,
      isFallback: false,
    };
    for (const fallback of model.fallbackModels ?? []) {
      models[fallback.modelConfigVersionId] = {
        name: fallback.name,
        providerType: fallback.providerType,
        modelId: fallback.modelId,
        pricing: fallback.pricing ?? null,
        isFallback: true,
      };
    }
  }
  if (snapshot.dialogue?.generatorModel) {
    const generator = snapshot.dialogue.generatorModel;
    models[generator.modelConfigVersionId] = {
      name: generator.name,
      providerType: generator.providerType,
      modelId: generator.modelId,
      pricing: generator.pricing ?? null,
      isFallback: false,
    };
  }
  const cases = Object.fromEntries(
    snapshot.testSet.cases.map((item) => [
      item.caseVersionId,
      { preview: previewText(item.input), input: item.input, expected: item.expected, meta: item.meta },
    ]),
  );
  return {
    ...data,
    trials: limitedTrials,
    trialTotal: data.trials.length,
    trialLimit,
    trialOffset,
    labels: { variants, models, cases, testSetName: snapshot.testSet.name },
    evaluations: listEvaluations(ctx, runId),
    snapshotSummary: {
      hash: snapshot.hash,
      createdAt: snapshot.createdAt,
      repetitions: snapshot.repetitions,
      budget: snapshot.budget,
      execution: snapshot.dialogue
        ? {
            ...snapshot.execution,
            dialogue: {
              maxRounds: snapshot.dialogue.maxRounds,
              generatorModel: snapshot.dialogue.generatorModel.name,
              initialInputPolicy: snapshot.dialogue.initialInputPolicy,
              maxOutputTokensPerTurn: snapshot.dialogue.maxOutputTokensPerTurn,
              termination: snapshot.dialogue.termination,
              callsPerTrial:
                snapshot.dialogue.maxRounds +
                (snapshot.dialogue.initialInputPolicy === 'case_first'
                  ? snapshot.dialogue.maxRounds - 1
                  : snapshot.dialogue.maxRounds),
            },
          }
        : snapshot.execution,
      variants: snapshot.variants.map((variant) => variant.label),
      models: snapshot.models.map((model) => model.name),
      caseCount: snapshot.testSet.cases.length,
      evaluation: buildEvaluationSummary(snapshot),
    },
  };
}

function buildEvaluationSummary(snapshot) {
  const weights = normalizedWeights(snapshot.evaluation.config.dimensions);
  return {
    name: snapshot.evaluation.name,
    scale: snapshot.evaluation.config.scale ?? null,
    weightTotal: weights.total,
    dimensions: snapshot.evaluation.config.dimensions.map((dimension) => ({
      ...dimension,
      normalizedWeight: weights.byDimension[dimension.id],
    })),
  };
}

/** 按实际模型与价格表汇总运行成本；未知价格显式标记，不按 0 计。 */
export function runCostSummary(ctx, runId) {
  const runRow = ctx.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!runRow) throw createError('NOT_FOUND_RUN', { message: `运行不存在: ${runId}` });
  const snapshot = loadSnapshot(ctx, runRow.snapshot_id);
  const pricingById = new Map();
  for (const model of snapshot.models) {
    pricingById.set(model.modelConfigVersionId, { name: model.name, pricing: model.pricing });
    for (const fallback of model.fallbackModels ?? []) {
      pricingById.set(fallback.modelConfigVersionId, { name: fallback.name, pricing: fallback.pricing });
    }
  }
  if (snapshot.dialogue?.generatorModel) {
    const generator = snapshot.dialogue.generatorModel;
    pricingById.set(generator.modelConfigVersionId, { name: generator.name, pricing: generator.pricing });
  }
  const attempts = ctx.db
    .prepare(
      `SELECT a.* FROM attempts a JOIN trials t ON t.id = a.trial_id WHERE t.run_id = ? AND a.status = 'succeeded'`,
    )
    .all(runId);
  const byModel = {};
  let amount = '0';
  let currency = null;
  let unknown = false;
  let latencyTotal = 0;
  let latencyCount = 0;
  const latencies = [];
  for (const attempt of attempts) {
    const meta = pricingById.get(attempt.actual_model_config_version_id) ?? { name: attempt.actual_model_id, pricing: null };
    const usage = attempt.normalized_usage_json ? JSON.parse(attempt.normalized_usage_json) : {};
    const cost = computeUsageCost(usage, meta.pricing);
    const entry = (byModel[meta.name] ??= { amount: '0', currency: null, requests: 0, unknown: false });
    entry.requests++;
    if (cost.amount === null) {
      unknown = true;
      entry.unknown = true;
    } else {
      amount = addAmounts(amount, cost.amount) ?? amount;
      entry.amount = addAmounts(entry.amount, cost.amount) ?? entry.amount;
      currency = cost.currency ?? currency;
      entry.currency = cost.currency ?? entry.currency;
    }
    if (attempt.started_at && attempt.finished_at) {
      const duration = new Date(attempt.finished_at) - new Date(attempt.started_at);
      latencyTotal += duration;
      latencyCount++;
      latencies.push(duration);
    }
  }
  const judge = { enabled: Boolean(snapshot.evaluation.config.judge?.enabled), model: null, calls: 0, amount: '0', currency: null, unknown: false };
  if (judge.enabled) {
    const judgeVersionId = snapshot.spec.evaluation.judgeModelConfigVersionId ?? null;
    let judgeModel = null;
    if (judgeVersionId) {
      try {
        judgeModel = getModelConfigVersion(ctx, judgeVersionId);
      } catch {
        judgeModel = null;
      }
    }
    judge.model = judgeModel?.name ?? null;
    for (const evaluation of listEvaluations(ctx, runId)) {
      const usages = Array.isArray(evaluation.scores?.judgeUsage) ? evaluation.scores.judgeUsage : [];
      for (const usage of usages) {
        judge.calls++;
        const cost = computeUsageCost(usage, judgeModel?.pricing ?? null);
        if (cost.amount === null) judge.unknown = true;
        else {
          judge.amount = addAmounts(judge.amount, cost.amount) ?? judge.amount;
          judge.currency = cost.currency ?? judge.currency;
        }
      }
    }
    if (judge.calls > 0) {
      const label = `${judgeModel?.name ?? 'judge'} (judge)`;
      const entry = (byModel[label] ??= { amount: '0', currency: null, requests: 0, unknown: false });
      entry.requests += judge.calls;
      if (judge.unknown) {
        unknown = true;
        entry.unknown = true;
      } else {
        amount = addAmounts(amount, judge.amount) ?? amount;
        entry.amount = addAmounts(entry.amount, judge.amount) ?? entry.amount;
        currency = judge.currency ?? currency;
        entry.currency = judge.currency ?? entry.currency;
      }
    }
  }

  return {
    amount: unknown ? null : formatAmount(Number(amount)),
    currency,
    complete: !unknown,
    judge: {
      enabled: judge.enabled,
      model: judge.model,
      calls: judge.calls,
      amount: judge.unknown ? null : formatAmount(Number(judge.amount)),
      currency: judge.currency,
      complete: !judge.unknown,
    },
    byModel: Object.entries(byModel).map(([name, entry]) => ({
      name,
      requests: entry.requests,
      amount: entry.unknown ? null : entry.amount,
      currency: entry.currency,
      complete: !entry.unknown,
    })),
    averageLatencyMs: latencyCount ? Math.round(latencyTotal / latencyCount) : null,
    latency: {
      count: latencyCount,
      averageMs: latencyCount ? Math.round(latencyTotal / latencyCount) : null,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      maxMs: latencies.length ? Math.round(Math.max(...latencies)) : null,
    },
    requestCount: attempts.length,
  };
}

/** 分析页最小版：按运行聚合趋势、失败与成本。 */
export function projectAnalytics(ctx, { limit = 30 } = {}) {
  const { runs } = listRuns(ctx, { limit, offset: 0 });
  const failures = ctx.db
    .prepare(
      `SELECT t.ineligibility_reasons_json AS reasons, COUNT(*) AS n
       FROM trials t WHERE t.run_id IN (SELECT id FROM runs ORDER BY created_at DESC LIMIT ?)
       GROUP BY t.ineligibility_reasons_json`,
    )
    .all(clampLimit(limit));
  const reasonCounts = {};
  for (const row of failures) {
    for (const reason of JSON.parse(row.reasons ?? '[]')) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + Number(row.n);
    }
  }
  return {
    runs: [...runs].reverse(),
    failureReasons: Object.entries(reasonCounts)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    totals: {
      runs: runs.length,
      completed: runs.filter((run) => run.status === 'completed').length,
      withErrors: runs.filter((run) => run.status === 'completed_with_errors').length,
      canceled: runs.filter((run) => run.status === 'canceled').length,
      failed: runs.filter((run) => run.status === 'failed').length,
    },
  };
}

export function listAuditEvents(ctx, { limit = 50, offset = 0 } = {}) {
  const total = Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n);
  const rows = ctx.db
    .prepare('SELECT * FROM audit_events ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
    .all(clampLimit(limit), Math.max(0, offset));
  return {
    total,
    events: rows.map((row) => ({
      id: row.id,
      type: row.type,
      actor: row.actor,
      payload: row.payload_json ? JSON.parse(row.payload_json) : null,
      createdAt: row.created_at,
    })),
  };
}

export function previewText(value) {
  if (value === null || value === undefined) return '（空）';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function clampLimit(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return 20;
  return Math.min(number, 200);
}

/** 最近秩百分位；样本为空时返回 null，避免把“无数据”显示成 0。 */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]);
}
