import { ulid } from '../core/ids.js';
import { nowIso } from '../core/time.js';
import { hashJson } from '../core/hash.js';
import { getModelConfigVersion } from '../core/models.js';
import { evaluateRules, combineDimensionScore, weightedOverall, toScaleScore } from './rules.js';
import { normalizedWeights } from './profile.js';
import { judgeTrial } from './judge.js';

/**
 * 评估引擎只消费执行侧产出的 outputValidity，不重新判定传输事实。
 * 无效输出不进入均值，trial 被标记 comparisonEligible=false。
 */
export async function evaluateRun(ctx, { runId, snapshot, signal, fetchImpl }) {
  const profile = snapshot.evaluation;
  const dimensions = profile.config.dimensions;
  const scale = profile.config.scale ?? null;
  const weights = normalizedWeights(dimensions);
  const judgeConfig = profile.config.judge ?? null;
  const loopWarnings = [];
  let judgeModel = null;
  if (judgeConfig?.enabled) {
    const judgeVersionId = snapshot.spec.evaluation.judgeModelConfigVersionId;
    if (!judgeVersionId) {
      loopWarnings.push({ code: 'JUDGE_MODEL_MISSING', message: '评分方案启用 judge，但实验规格未指定 judgeModelConfigVersionId，已退回纯规则评估。' });
    } else {
      judgeModel = getModelConfigVersion(ctx, judgeVersionId);
    }
  }
  let instructions = null;
  if (judgeConfig?.promptVersionId || snapshot.spec.evaluation.judgePromptVersionId) {
    const promptVersionId = judgeConfig?.promptVersionId ?? snapshot.spec.evaluation.judgePromptVersionId;
    const row = ctx.db.prepare('SELECT content FROM prompt_versions WHERE id = ?').get(promptVersionId);
    if (row) instructions = row.content;
    else loopWarnings.push({ code: 'JUDGE_PROMPT_MISSING', message: `Judge 提示词版本不存在: ${promptVersionId}` });
  }
  if (!instructions && judgeConfig?.defaultInstructions) instructions = judgeConfig.defaultInstructions;

  const evaluationVersionId = ulid();
  ctx.db
    .prepare('INSERT INTO evaluation_versions(id, run_id, profile_version_id, content_hash, created_at) VALUES(?,?,?,?,?)')
    .run(evaluationVersionId, runId, profile.profileVersionId, hashJson({ snapshotHash: snapshot.hash, profileHash: profile.contentHash }), nowIso());

  const cases = new Map(snapshot.testSet.cases.map((item) => [item.caseVersionId, item]));
  const trials = ctx.db.prepare('SELECT * FROM trials WHERE run_id = ? ORDER BY created_at, id').all(runId);
  const summary = { evaluationVersionId, completed: 0, incomplete: 0, failed: 0, skipped: 0, judgeErrors: 0, warnings: loopWarnings };

  for (const trial of trials) {
    if (trial.trial_status !== 'completed') {
      const prior = JSON.parse(trial.ineligibility_reasons_json ?? '[]').filter((reason) => reason !== 'pending_execution');
      setTrialEvaluation(ctx, trial, 'not_requested', false, [...new Set([...prior, ...reasonsForStatus(trial.trial_status)])]);
      summary.skipped++;
      continue;
    }
    if (trial.output_validity !== 'valid') {
      const prior = JSON.parse(trial.ineligibility_reasons_json ?? '[]').filter((reason) => reason !== 'pending_execution');
      setTrialEvaluation(ctx, trial, 'incomplete', false, [...new Set([...prior, 'invalid_output'])], true);
      insertEvaluation(ctx, {
        trialId: trial.id,
        evaluationVersionId,
        status: 'incomplete',
        scores: { skipped: 'invalid_output', outputValidity: trial.output_validity },
        overall: null,
      });
      summary.incomplete++;
      continue;
    }

    const output = trial.output_json ? JSON.parse(trial.output_json) : {};
    const testCase = cases.get(trial.case_version_id) ?? { input: null, expected: null, meta: null };
    const dimensionScores = {};
    const details = {};
    const consistencyValues = [];
    const judgeUsage = [];
    let gateFailed = null;

    for (const dimension of dimensions) {
      const ruleResult = evaluateRules(dimension.rules ?? [], { content: output.content, expected: testCase.expected, caseMeta: testCase.meta });
      let judgeScore = null;
      let judgeRuns = [];
      let judgeErrors = [];
      let judgeConsistency = null;
      if (judgeModel) {
        try {
          const judged = await judgeTrial({
            judgeModel,
            dimensions: [dimension],
            content: output.content,
            caseInput: testCase.input,
            expected: testCase.expected,
            instructions,
            repetitions: snapshot.spec.evaluation.judgeRepetitions ?? 1,
            signal,
            fetchImpl,
            scale,
          });
          judgeRuns = judged.runs;
          judgeErrors = judged.errors;
          judgeConsistency = judged.consistency;
          if (judged.consistency !== null) consistencyValues.push(judged.consistency);
          for (const run of judged.runs) if (run.usage) judgeUsage.push(run.usage);
          if (judged.errors.length) {
            summary.judgeErrors += judged.errors.length;
            loopWarnings.push({ code: 'JUDGE_PARTIAL', message: `评审模型部分调用失败: ${judged.errors[0].message}` });
          }
          if (judged.scores[dimension.id] !== undefined) judgeScore = judged.scores[dimension.id];
        } catch (error) {
          summary.judgeErrors++;
          loopWarnings.push({ code: 'JUDGE_FAILED', message: `评审模型调用失败: ${error.message}` });
        }
      }
      const score = combineDimensionScore(ruleResult.score, judgeScore);
      dimensionScores[dimension.id] = score;
      details[dimension.id] = {
        rules: ruleResult.results,
        ruleScore: ruleResult.score,
        judgeScore,
        judgeRuns,
        judgeErrors,
        judgeConsistency,
        score,
        scaleScore: toScaleScore(score, scale),
        weight: dimension.weight,
        normalizedWeight: weights.byDimension[dimension.id] ?? null,
        gating: Boolean(dimension.gating),
        gate: dimension.gate ?? null,
      };
      if (dimension.gating && score !== null && score < Number(dimension.gate ?? 0.5)) {
        gateFailed = { dimension: dimension.id, score, gate: dimension.gate ?? 0.5 };
      }
    }

    const overall = weightedOverall(dimensionScores, dimensions);
    const missingDimensions = dimensions.filter((dimension) => dimensionScores[dimension.id] == null).map((dimension) => dimension.id);
    const judgeConsistency = consistencyValues.length ? consistencyValues.reduce((sum, value) => sum + value, 0) / consistencyValues.length : null;
    let status = missingDimensions.length ? 'incomplete' : 'completed';
    if (judgeModel && summary.judgeErrors > 0) status = 'incomplete';
    const priorReasons = JSON.parse(trial.ineligibility_reasons_json ?? '[]').filter(
      (reason) => !['pending_execution', 'invalid_output'].includes(reason),
    );
    const gateReasons = missingDimensions.length || gateFailed ? ['missing_required_dimension'] : [];
    const reasons = [...new Set([...priorReasons, ...gateReasons])];
    const eligible = status === 'completed' && !gateFailed && reasons.length === 0;

    setTrialEvaluation(ctx, trial, status, eligible, reasons, true);
    insertEvaluation(ctx, {
      trialId: trial.id,
      evaluationVersionId,
      status,
      scores: {
        dimensions: dimensionScores,
        details,
        overall,
        gateFailed,
        judgeConsistency,
        judgeUsage,
        judgeModelConfigVersionId: judgeModel?.modelConfigVersionId ?? null,
      },
      overall,
    });
    if (status === 'completed') summary.completed++;
    else if (status === 'incomplete') summary.incomplete++;
    else summary.failed++;
  }

  return summary;
}

function reasonsForStatus(trialStatus) {
  if (trialStatus === 'canceled') return ['canceled'];
  if (trialStatus === 'aborted_unknown') return ['unknown_state'];
  return ['unknown_state'];
}

function setTrialEvaluation(ctx, trial, status, eligible, reasons, clear = false) {
  const merged = clear ? new Set() : new Set(JSON.parse(trial.ineligibility_reasons_json ?? '[]'));
  for (const reason of reasons) merged.add(reason);
  ctx.db
    .prepare('UPDATE trials SET evaluation_status = ?, comparison_eligible = ?, ineligibility_reasons_json = ?, updated_at = ? WHERE id = ?')
    .run(status, eligible ? 1 : 0, JSON.stringify([...merged]), nowIso(), trial.id);
}

function insertEvaluation(ctx, { trialId, evaluationVersionId, status, scores, overall }) {
  ctx.db
    .prepare('INSERT INTO evaluations(id, trial_id, evaluation_version_id, status, scores_json, overall_score, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(ulid(), trialId, evaluationVersionId, status, JSON.stringify(scores), overall, nowIso());
}

export function listEvaluations(ctx, runId) {
  return ctx.db
    .prepare(
      `SELECT e.*, t.case_version_id, t.variant_version_id, t.model_config_version_id
       FROM evaluations e JOIN trials t ON t.id = e.trial_id
       WHERE t.run_id = ? ORDER BY e.created_at, e.id`,
    )
    .all(runId)
    .map((row) => ({
      evaluationId: row.id,
      trialId: row.trial_id,
      status: row.status,
      overallScore: row.overall_score,
      scores: row.scores_json ? JSON.parse(row.scores_json) : null,
      caseVersionId: row.case_version_id,
      variantVersionId: row.variant_version_id,
      modelConfigVersionId: row.model_config_version_id,
    }));
}

export function evaluationVersionForRun(ctx, runId) {
  return ctx.db.prepare('SELECT * FROM evaluation_versions WHERE run_id = ? ORDER BY created_at DESC LIMIT 1').get(runId) ?? null;
}
