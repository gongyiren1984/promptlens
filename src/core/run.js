import { createError } from './errors.js';
import { hashJson, hashText, canonicalJson } from './hash.js';
import { ulid } from './ids.js';
import { nowIso, sleep } from './time.js';
import { transaction } from './db.js';
import { acquireProjectLock } from './lock.js';
import { putObject } from './objects.js';
import { callModel, computeUsageCost, addAmounts, findModelByName, getModelConfigVersion } from './models.js';
import { renderPrompt } from './assets.js';
import { preflight, persistSnapshot, loadSnapshot, trialCount } from './spec.js';
import { evaluateRun, evaluationVersionForRun } from '../eval/engine.js';
import { recordAudit } from './audit.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'completed_with_errors', 'canceled', 'failed']);

/**
 * 指数退避 + 随机抖动：base * 2^(attempt-1)，叠加 ±20% 抖动后截断到 maxMs，
 * 并保证不低于服务端 retryAfterMs。抖动系数可注入以便测试。
 */
export function computeBackoffMs({ baseMs, maxMs, attempt, retryAfterMs = 0, random = Math.random }) {
  const base = Math.min(Number(maxMs), Number(baseMs) * 2 ** (Math.max(1, Number(attempt)) - 1));
  const jitter = base * 0.2 * (random() * 2 - 1);
  const jittered = Math.max(0, Math.round(base + jitter));
  return Math.max(jittered, Number(retryAfterMs) || 0);
}


export function resolveModelArg(ctx, ref) {
  try {
    return findModelByName(ctx, ref);
  } catch (error) {
    if (error.code !== 'NOT_FOUND_MODEL') throw error;
    return getModelConfigVersion(ctx, ref);
  }
}

export function createRun(ctx, spec, options = {}) {
  const plan = preflight(ctx, spec);
  if (spec.budget.maxRequests && plan.trialCount > spec.budget.maxRequests) {
    throw createError('BUDGET_EXCEEDED', {
      message: `计划 ${plan.trialCount} 个 Trial，超过 maxRequests=${spec.budget.maxRequests}。`,
      details: { trialCount: plan.trialCount, maxRequests: spec.budget.maxRequests },
    });
  }
  const requestHash = hashJson(spec);
  const idempotencyKey = options.idempotencyKey ?? null;

  if (idempotencyKey) {
    const existing = ctx.db.prepare('SELECT * FROM idempotency WHERE key = ?').get(idempotencyKey);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw createError('STATE_IDEMPOTENCY_CONFLICT', {
          message: '同一幂等键对应了不同的实验规格。',
          details: { idempotencyKey },
        });
      }
      return { ...JSON.parse(existing.result_json), reused: true, plan: plan.plan };
    }
  }

  const persisted = persistSnapshot(ctx, plan.snapshot);
  const runId = ulid();
  const createdAt = nowIso();
  const trials = expandTrials(plan.snapshot, runId, createdAt);

  transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO runs(id, project_id, snapshot_id, snapshot_hash, status, parent_run_id, stop_reason, request_hash, created_at, started_at, finished_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(runId, ctx.projectId, persisted.snapshotId, persisted.snapshotHash, 'queued', options.parentRunId ?? null, null, requestHash, createdAt, null, null, createdAt);
    const insertTrial = ctx.db.prepare(
      `INSERT INTO trials(id, run_id, variant_version_id, case_version_id, model_config_version_id, repetition_index, idempotency_key, trial_status, output_validity, evaluation_status, comparison_eligible, ineligibility_reasons_json, truncated, output_json, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const trial of trials) {
      insertTrial.run(
        trial.id,
        runId,
        trial.variantVersionId,
        trial.caseVersionId,
        trial.modelConfigVersionId,
        trial.repetitionIndex,
        trial.idempotencyKey,
        'queued',
        'not_available',
        'not_requested',
        0,
        JSON.stringify(['pending_execution']),
        0,
        null,
        createdAt,
        createdAt,
      );
    }
    if (idempotencyKey) {
      const result = { runId, snapshotId: persisted.snapshotId, snapshotHash: persisted.snapshotHash, trialCount: trials.length };
      ctx.db
        .prepare('INSERT INTO idempotency(key, scope, request_hash, result_json, created_at) VALUES(?,?,?,?,?)')
        .run(idempotencyKey, 'run.start', requestHash, JSON.stringify(result), createdAt);
    }
    appendEventInTx(ctx, runId, 'run_created', { trialCount: trials.length, parentRunId: options.parentRunId ?? null });
  });

  recordAudit(ctx, 'run.created', {
    runId,
    snapshotHash: persisted.snapshotHash,
    trialCount: trials.length,
    idempotencyKey,
    parentRunId: options.parentRunId ?? null,
  });
  return {
    runId,
    snapshotId: persisted.snapshotId,
    snapshotHash: persisted.snapshotHash,
    trialCount: trials.length,
    status: 'queued',
    reused: false,
    plan: plan.plan,
    warnings: plan.warnings,
    estimate: plan.estimate,
  };
}function expandTrials(snapshot, runId, createdAt) {
  const items = [];
  snapshot.variants.forEach((variant, variantIndex) => {
    snapshot.testSet.cases.forEach((testCase) => {
      snapshot.models.forEach((model) => {
        for (let repetition = 0; repetition < snapshot.repetitions; repetition++) {
          const idempotencyKey = hashJson({
            runId,
            variantVersionId: variant.promptVersionId,
            caseVersionId: testCase.caseVersionId,
            modelConfigVersionId: model.modelConfigVersionId,
            repetitionIndex: repetition,
          });
          items.push({
            id: ulid(Date.now() + variantIndex),
            variantVersionId: variant.promptVersionId,
            caseVersionId: testCase.caseVersionId,
            modelConfigVersionId: model.modelConfigVersionId,
            repetitionIndex: repetition,
            idempotencyKey,
          });
        }
      });
    });
  });
  const order = snapshot.execution.order;
  if (order === 'seeded_random') {
    items.sort((a, b) => {
      const ha = hashJson({ seed: snapshot.execution.seed, key: a.idempotencyKey });
      const hb = hashJson({ seed: snapshot.execution.seed, key: b.idempotencyKey });
      return ha < hb ? -1 : 1;
    });
  }
  return items;
}

export function deriveRetryRun(ctx, sourceRunId) {
  const source = ctx.db.prepare('SELECT * FROM runs WHERE id = ?').get(sourceRunId);
  if (!source) throw createError('NOT_FOUND_RUN', { message: `运行不存在: ${sourceRunId}` });
  const failed = ctx.db
    .prepare("SELECT * FROM trials WHERE run_id = ? AND trial_status IN ('failed','aborted_unknown','canceled')")
    .all(sourceRunId);
  if (!failed.length) {
    throw createError('STATE_INVALID_TRANSITION', { message: '该运行没有可重试的失败 Trial。' });
  }
  const snapshot = loadSnapshot(ctx, source.snapshot_id);
  const runId = ulid();
  const createdAt = nowIso();
  transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO runs(id, project_id, snapshot_id, snapshot_hash, status, parent_run_id, stop_reason, request_hash, created_at, started_at, finished_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(runId, source.project_id, source.snapshot_id, source.snapshot_hash, 'queued', sourceRunId, null, source.request_hash, createdAt, null, null, createdAt);
    const insertTrial = ctx.db.prepare(
      `INSERT INTO trials(id, run_id, variant_version_id, case_version_id, model_config_version_id, repetition_index, idempotency_key, trial_status, output_validity, evaluation_status, comparison_eligible, ineligibility_reasons_json, truncated, output_json, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const trial of failed) {
      const key = hashJson({ runId, sourceTrialId: trial.id });
      insertTrial.run(
        ulid(),
        runId,
        trial.variant_version_id,
        trial.case_version_id,
        trial.model_config_version_id,
        trial.repetition_index,
        key,
        'queued',
        'not_available',
        'not_requested',
        0,
        JSON.stringify(['pending_execution']),
        0,
        null,
        createdAt,
        createdAt,
      );
    }
    appendEventInTx(ctx, runId, 'run_created', { retryOf: sourceRunId, trialCount: failed.length });
  });
  recordAudit(ctx, 'run.retry_created', { runId, parentRunId: sourceRunId, trialCount: failed.length });
  return { runId, parentRunId: sourceRunId, trialCount: failed.length, status: 'queued', snapshotHash: source.snapshot_hash };
}

export async function executeRun(ctx, runId, options = {}) {
  const run = ctx.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) throw createError('NOT_FOUND_RUN', { message: `运行不存在: ${runId}` });
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    return { runId, status: run.status, skipped: true };
  }
  const snapshot = loadSnapshot(ctx, run.snapshot_id);
  const lock = acquireProjectLock(ctx.root);
  const controller = new AbortController();
  const startedAt = Date.now();
  const budget = {
    requests: 0,
    tokens: 0,
    amountKnown: 0,
    amountUnknown: false,
    stopReason: null,
    limit: snapshot.budget,
    startedAt,
  };
  let cancelRequested = false;

  const watcher = setInterval(() => {
    try {
      const current = ctx.db.prepare('SELECT status FROM runs WHERE id = ?').get(runId);
      if (current?.status === 'cancel_requested') {
        cancelRequested = true;
        controller.abort(new Error('cancel_requested'));
      }
    } catch {
      /* 数据库瞬时忙时忽略，下轮继续 */
    }
  }, 200);

  try {
    ctx.db.prepare('UPDATE runs SET status = ?, started_at = ?, updated_at = ? WHERE id = ?').run('running', nowIso(), nowIso(), runId);
    appendEvent(ctx, runId, 'run_started', { trialCount: countTrials(ctx, runId) });

    const trials = ctx.db
      .prepare("SELECT * FROM trials WHERE run_id = ? AND trial_status IN ('queued','retrying') ORDER BY created_at, id")
      .all(runId);

    await runPool(trials, snapshot.execution.maxConcurrency, async (trial) => {
      if (cancelRequested) {
        markTrial(ctx, trial.id, { trialStatus: 'canceled', reasons: ['canceled'] });
        return;
      }
      if (budget.stopReason) {
        markTrial(ctx, trial.id, { trialStatus: 'canceled', reasons: ['budget_exhausted'] });
        return;
      }
      await executeTrial(ctx, { runId, snapshot, trial, controller, budget, fetchImpl: options.fetchImpl, isCancelled: () => cancelRequested });
    });

    const evaluationSummary = await evaluateRun(ctx, {
      runId,
      snapshot,
      signal: controller.signal,
      fetchImpl: options.fetchImpl,
    });
    appendEvent(ctx, runId, 'evaluation_completed', {
      evaluationVersionId: evaluationSummary.evaluationVersionId,
      completed: evaluationSummary.completed,
      incomplete: evaluationSummary.incomplete,
      skipped: evaluationSummary.skipped,
    });

    const counts = countTrialsByStatus(ctx, runId);
    const priorStopReason = ctx.db.prepare('SELECT stop_reason FROM runs WHERE id = ?').get(runId)?.stop_reason ?? null;
    let status;
    let stopReason = null;
    if (cancelRequested) {
      status = 'canceled';
      stopReason = 'user_cancel';
    } else if (budget.stopReason) {
      status = 'completed_with_errors';
      stopReason = budget.stopReason;
    } else if (counts.failed > 0 || counts.abortedUnknown > 0) {
      status = 'completed_with_errors';
    } else {
      status = 'completed';
    }
    ctx.db
      .prepare('UPDATE runs SET status = ?, stop_reason = ?, finished_at = ?, updated_at = ? WHERE id = ?')
      .run(status, stopReason ?? priorStopReason, nowIso(), nowIso(), runId);
    appendEvent(ctx, runId, 'run_finished', { status, stopReason, counts });
    return { runId, status, stopReason, counts, evaluation: evaluationSummary, durationMs: Date.now() - startedAt };
  } catch (error) {
    try {
      ctx.db
        .prepare('UPDATE runs SET status = ?, stop_reason = ?, finished_at = ?, updated_at = ? WHERE id = ?')
        .run('failed', error.code === 'BUDGET_EXCEEDED' ? 'budget_exceeded' : 'fatal_error', nowIso(), nowIso(), runId);
      appendEvent(ctx, runId, 'run_failed', { code: error.code ?? 'INTERNAL_UNEXPECTED', message: error.message });
    } catch {
      /* 保留原始错误 */
    }
    throw error;
  } finally {
    clearInterval(watcher);
    lock.release();
  }
}

async function executeTrial(ctx, { runId, snapshot, trial, controller, budget, fetchImpl, isCancelled }) {
  const variant = snapshot.variants.find((item) => item.promptVersionId === trial.variant_version_id);
  const testCase = snapshot.testSet.cases.find((item) => item.caseVersionId === trial.case_version_id);
  const primary = snapshot.models.find((item) => item.modelConfigVersionId === trial.model_config_version_id);
  if (!variant || !testCase || !primary) {
    markTrial(ctx, trial.id, { trialStatus: 'failed', reasons: ['unknown_state'] });
    return;
  }
  if (snapshot.dialogue) {
    return executeDialogueTrial(ctx, { snapshot, trial, variant, testCase, primary, controller, budget, fetchImpl, isCancelled });
  }

  const render = renderPrompt(variant.content, testCase.input);
  const userContent = typeof testCase.input === 'string' ? render.rendered : JSON.stringify(testCase.input, null, 2);
  const messages = [
    { role: 'system', content: render.rendered },
    { role: 'user', content: userContent },
  ];

  const candidates = [{ model: primary, fallback: false }, ...(primary.fallbackModels ?? []).map((model) => ({ model, fallback: true }))];
  let attemptNumber = 0;
  let lastError = null;
  let fallbackUsed = false;

  for (const candidate of candidates) {
    for (let localAttempt = 1; localAttempt <= snapshot.execution.maxAttempts; localAttempt++) {
      if (controller.signal.aborted || isCancelled()) {
        markTrial(ctx, trial.id, { trialStatus: 'canceled', reasons: ['canceled'] });
        return;
      }
      const budgetStop = checkBudget(budget, snapshot);
      if (budgetStop) {
        budget.stopReason = budgetStop;
        markTrial(ctx, trial.id, { trialStatus: 'canceled', reasons: ['budget_exhausted'] });
        return;
      }
      attemptNumber += 1;
      const attemptId = ulid();
      const startedAt = nowIso();
      ctx.db
        .prepare(
          `INSERT INTO attempts(id, trial_id, attempt_number, status, started_at, original_model_config_version_id, actual_model_config_version_id, original_model_id, actual_model_id, fallback_used, cross_model_substitution, billing_state)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          attemptId,
          trial.id,
          attemptNumber,
          'in_flight',
          startedAt,
          primary.modelConfigVersionId,
          candidate.model.modelConfigVersionId,
          primary.modelId,
          candidate.model.modelId,
          candidate.fallback ? 1 : 0,
          candidate.fallback ? 1 : 0,
          candidate.model.pricing ? 'known' : 'unknown',
        );
      ctx.db.prepare('UPDATE trials SET trial_status = ?, updated_at = ? WHERE id = ?').run('running', nowIso(), trial.id);
      budget.requests += 1;

      try {
        const result = await callModel({
          modelConfig: candidate.model,
          messages,
          caseMeta: testCase.meta,
          variantLabel: variant.label,
          attemptNumber,
          signal: controller.signal,
          fetchImpl,
          promptText: render.rendered,
          caseInput: testCase.input,
        });
        const cost = computeUsageCost(result.usage, candidate.model.pricing);
        budget.tokens += (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);
        if (cost.amount !== null) budget.amountKnown = Number(addAmounts(String(budget.amountKnown), cost.amount) ?? budget.amountKnown);
        else budget.amountUnknown = true;

        const responseRef = putObject(ctx.root, `${JSON.stringify({ content: result.content, finishReason: result.finishReason, usage: result.usage }, null, 2)}\n`).ref;
        ctx.db
          .prepare(
            `UPDATE attempts SET status = ?, finished_at = ?, response_ref = ?, normalized_usage_json = ? WHERE id = ?`,
          )
          .run('succeeded', nowIso(), responseRef, JSON.stringify(result.usage), attemptId);

        const validity = normalizeOutput(result, testCase);
        if (candidate.fallback) fallbackUsed = true;
        const reasons = [];
        if (candidate.fallback) reasons.push('cross_model_fallback');
        if (validity !== 'valid') reasons.push('invalid_output');
        markTrial(ctx, trial.id, {
          trialStatus: 'completed',
          outputValidity: validity,
          output: {
            content: result.content,
            finishReason: result.finishReason,
            truncated: validity === 'invalid_truncated',
            modelConfigVersionId: candidate.model.modelConfigVersionId,
            modelId: result.modelId,
            usage: result.usage,
            cost,
            latencyMs: result.latencyMs,
            fallbackUsed: candidate.fallback,
            attemptId,
          },
          reasons,
          eligible: validity === 'valid' && !candidate.fallback,
          truncated: validity === 'invalid_truncated',
          evaluationStatus: 'pending',
        });
        return;
      } catch (error) {
        lastError = error;
        const aborted = controller.signal.aborted || error.name === 'AbortError';
        ctx.db
          .prepare('UPDATE attempts SET status = ?, finished_at = ?, error_json = ? WHERE id = ?')
          .run(aborted ? 'canceled' : 'failed', nowIso(), JSON.stringify({ code: error.code ?? 'PROVIDER_UNAVAILABLE', retryable: Boolean(error.retryable), message: error.message }), attemptId);

        if (aborted) {
          markTrial(ctx, trial.id, { trialStatus: 'canceled', reasons: ['canceled'] });
          return;
        }
        if (error.code === 'PROVIDER_POLICY_BLOCKED') {
          if (candidate.fallback) fallbackUsed = true;
          markTrial(ctx, trial.id, {
            trialStatus: 'completed',
            outputValidity: 'policy_blocked',
            output: { content: null, finishReason: 'policy_blocked', modelConfigVersionId: candidate.model.modelConfigVersionId, modelId: candidate.model.modelId, fallbackUsed: candidate.fallback, attemptId, error: { code: error.code, message: error.message } },
            reasons: ['invalid_output', ...(candidate.fallback ? ['cross_model_fallback'] : [])],
            eligible: false,
            evaluationStatus: 'not_requested',
          });
          return;
        }
        const retryable = Boolean(error.retryable);
        const lastAttemptOnModel = localAttempt >= snapshot.execution.maxAttempts;
        if (!retryable || lastAttemptOnModel) break;
        const waitMs = computeBackoffMs({
          baseMs: snapshot.execution.backoffBaseMs,
          maxMs: snapshot.execution.maxBackoffMs,
          attempt: localAttempt,
          retryAfterMs: error.details?.retryAfterMs ?? 0,
        });
        ctx.db.prepare('UPDATE trials SET trial_status = ?, updated_at = ? WHERE id = ?').run('retrying', nowIso(), trial.id);
        try {
          await sleep(waitMs, controller.signal);
        } catch {
          markTrial(ctx, trial.id, { trialStatus: 'canceled', reasons: ['canceled'] });
          return;
        }
      }
    }
    if (candidate.fallback) fallbackUsed = true;
  }

  markTrial(ctx, trial.id, {
    trialStatus: 'failed',
    reasons: [fallbackUsed ? 'cross_model_fallback' : 'unknown_state'],
    evaluationStatus: 'not_requested',
    output: lastError
      ? { error: { code: lastError.code ?? 'PROVIDER_UNAVAILABLE', message: lastError.message, retryable: Boolean(lastError.retryable) } }
      : null,
  });
}

/* ---------------- 双模型多轮对话 ---------------- */

const DEFAULT_GENERATOR_PROMPT = `你是双模型对话中的生成模型 B。请根据测试用例与已有对话，生成下一条用户输入或追问。
只输出用户输入内容，不要解释。若对话已经完成，输出 <END>。`;

const NORMAL_TERMINATIONS = new Set(['round_limit', 'termination_literal', 'termination_regex', 'termination_json_condition']);

async function executeDialogueTrial(ctx, { snapshot, trial, variant, testCase, primary, controller, budget, fetchImpl, isCancelled }) {
  const dialogue = snapshot.dialogue;
  const render = renderPrompt(variant.content, testCase.input);
  const caseInput = typeof testCase.input === 'string' ? render.rendered : JSON.stringify(testCase.input, null, 2);
  const generatorSystem = dialogue.generatorPrompt
    ? renderPrompt(dialogue.generatorPrompt.content, testCase.input).rendered
    : DEFAULT_GENERATOR_PROMPT;

  const conversation = [];
  const usageTotals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
  let amountTotal = '0';
  let amountUnknown = false;
  let costCurrency = primary.pricing?.currency ?? null;
  let fallbackUsed = false;
  let rounds = 0;
  let generatorCalls = 0;
  let turnCount = 0;
  let lastAnswer = null;
  let lastModel = primary;
  let lastAttemptId = null;
  const startedAt = Date.now();
  let terminationReason = null;

  ctx.db.prepare('UPDATE trials SET trial_status = ?, updated_at = ? WHERE id = ?').run('running', nowIso(), trial.id);

  const recordTurn = (turn) => {
    const turnId = ulid();
    const createdAt = nowIso();
    ctx.db
      .prepare(
        `INSERT INTO dialogue_turns(id, trial_id, round, role, model_config_version_id, model_id, content, usage_json, termination_reason, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        turnId,
        trial.id,
        turn.round,
        turn.role,
        turn.model.modelConfigVersionId,
        turn.modelId ?? turn.model.modelId,
        turn.content ?? '',
        turn.usage ? JSON.stringify(turn.usage) : null,
        turn.terminationReason ?? null,
        createdAt,
      );
    turnCount += 1;
  };

  const accumulate = (result, modelConfig) => {
    usageTotals.inputTokens += Number(result.usage?.inputTokens ?? 0);
    usageTotals.outputTokens += Number(result.usage?.outputTokens ?? 0);
    usageTotals.cachedInputTokens += Number(result.usage?.cachedInputTokens ?? 0);
    usageTotals.reasoningTokens += Number(result.usage?.reasoningTokens ?? 0);
    const cost = computeUsageCost(result.usage ?? {}, modelConfig.pricing);
    if (cost.amount === null) amountUnknown = true;
    else amountTotal = addAmounts(amountTotal, cost.amount) ?? amountTotal;
    costCurrency = costCurrency ?? cost.currency;
  };

  const dialogueSummary = (reason) => ({
    maxRounds: dialogue.maxRounds,
    rounds,
    turns: turnCount,
    terminationReason: reason,
  });

  const finalize = (reason) => {
    const reasons = [];
    if (!NORMAL_TERMINATIONS.has(reason)) reasons.push(reason);
    if (fallbackUsed) reasons.push('cross_model_fallback');

    if (!lastAnswer) {
      markTrial(ctx, trial.id, {
        trialStatus: reason === 'canceled' || reason === 'budget_exhausted' ? 'canceled' : 'failed',
        reasons: reasons.length ? reasons : ['unknown_state'],
        evaluationStatus: 'not_requested',
        output: { dialogue: dialogueSummary(reason) },
      });
      return;
    }

    const validity = normalizeOutput({ content: lastAnswer.content, finishReason: lastAnswer.finishReason }, testCase);
    if (validity !== 'valid') reasons.push('invalid_output');
    markTrial(ctx, trial.id, {
      trialStatus: reason === 'canceled' ? 'canceled' : 'completed',
      outputValidity: validity,
      output: {
        content: lastAnswer.content,
        finishReason: lastAnswer.finishReason,
        truncated: validity === 'invalid_truncated',
        modelConfigVersionId: lastModel.modelConfigVersionId,
        modelId: lastAnswer.modelId,
        usage: { ...usageTotals, raw: { dialogue: true }, normalizerVersion: 'dialogue/1' },
        cost: { amount: amountUnknown ? null : amountTotal, currency: costCurrency, billingState: amountUnknown ? 'unknown' : 'known' },
        latencyMs: Date.now() - startedAt,
        fallbackUsed,
        attemptId: lastAttemptId,
        dialogue: dialogueSummary(reason),
      },
      reasons,
      eligible: validity === 'valid' && !fallbackUsed && NORMAL_TERMINATIONS.has(reason) && reason !== 'canceled',
      truncated: validity === 'invalid_truncated',
      evaluationStatus: reason === 'canceled' ? 'not_requested' : 'pending',
    });
  };

  try {
    for (let round = 1; round <= dialogue.maxRounds; round++) {
      rounds = round;
      const needsGenerator = dialogue.initialInputPolicy === 'generator_first' || round > 1;
      if (needsGenerator) {
        const generatorMessages = buildGeneratorMessages(generatorSystem, caseInput, conversation, round);
        let call;
        try {
          call = await dialogueModelCall(ctx, {
            snapshot,
            trial,
            originalModel: dialogue.generatorModel,
            modelConfig: dialogue.generatorModel,
            fallbacks: [],
            messages: generatorMessages,
            caseMeta: testCase.meta,
            variantLabel: 'generator',
            turnIndex: generatorCalls,
            caseInput: testCase.input,
            maxOutputTokensPerTurn: dialogue.maxOutputTokensPerTurn,
            controller,
            budget,
            fetchImpl,
            isCancelled,
          });
        } catch (error) {
          if (error.dialogueStop) throw error;
          terminationReason = 'generator_failed';
          break;
        }
        generatorCalls += 1;
        accumulate(call.result, call.model);
        const content = String(call.result.content ?? '');
        const matched = matchTermination(dialogue.termination, content);
        recordTurn({
          round,
          role: 'generator',
          model: call.model,
          modelId: call.result.modelId,
          content,
          usage: call.result.usage,
          terminationReason: matched?.reason ?? null,
        });
        conversation.push({ role: 'user', content });
        if (matched) {
          terminationReason = matched.reason;
          break;
        }
      } else {
        conversation.push({ role: 'user', content: caseInput });
      }

      const call = await (async () => {
        try {
          return await dialogueModelCall(ctx, {
            snapshot,
            trial,
            originalModel: primary,
            modelConfig: primary,
            fallbacks: primary.fallbackModels ?? [],
            messages: [{ role: 'system', content: render.rendered }, ...conversation],
            caseMeta: testCase.meta,
            variantLabel: variant.label,
            turnIndex: round - 1,
            caseInput: testCase.input,
            maxOutputTokensPerTurn: dialogue.maxOutputTokensPerTurn,
            controller,
            budget,
            fetchImpl,
            isCancelled,
          });
        } catch (error) {
          if (error.dialogueStop) throw error;
          terminationReason = 'candidate_failed';
          return null;
        }
      })();
      if (!call) break;
      accumulate(call.result, call.model);
      if (call.fallback) fallbackUsed = true;
      const content = String(call.result.content ?? '');
      const matched = matchTermination(dialogue.termination, content);
      recordTurn({
        round,
        role: 'candidate',
        model: call.model,
        modelId: call.result.modelId,
        content,
        usage: call.result.usage,
        terminationReason: matched?.reason ?? null,
      });
      conversation.push({ role: 'assistant', content });
      lastAnswer = { content, finishReason: call.result.finishReason, modelId: call.result.modelId };
      lastModel = call.model;
      lastAttemptId = call.attemptId;
      if (matched) {
        terminationReason = matched.reason;
        break;
      }
      if (round === dialogue.maxRounds) terminationReason = 'round_limit';
    }
  } catch (error) {
    if (!error.dialogueStop) throw error;
    terminationReason = error.dialogueStop;
  }

  finalize(terminationReason ?? 'round_limit');
}

async function dialogueModelCall(ctx, { snapshot, trial, originalModel, modelConfig, fallbacks, messages, caseMeta, variantLabel, turnIndex, caseInput, maxOutputTokensPerTurn, controller, budget, fetchImpl, isCancelled }) {
  const candidates = [{ model: modelConfig, fallback: false }, ...fallbacks.map((model) => ({ model, fallback: true }))];
  let attemptNumber = Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE trial_id = ?').get(trial.id).n);
  let lastError = null;

  for (const candidate of candidates) {
    for (let localAttempt = 1; localAttempt <= snapshot.execution.maxAttempts; localAttempt++) {
      if (controller.signal.aborted || isCancelled()) throw dialogueStop('canceled');
      const budgetStop = checkBudget(budget, snapshot);
      if (budgetStop) {
        budget.stopReason = budgetStop;
        throw dialogueStop('budget_exhausted');
      }
      attemptNumber += 1;
      const attemptId = ulid();
      const startedAt = nowIso();
      ctx.db
        .prepare(
          `INSERT INTO attempts(id, trial_id, attempt_number, status, started_at, original_model_config_version_id, actual_model_config_version_id, original_model_id, actual_model_id, fallback_used, cross_model_substitution, billing_state)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          attemptId,
          trial.id,
          attemptNumber,
          'in_flight',
          startedAt,
          originalModel.modelConfigVersionId,
          candidate.model.modelConfigVersionId,
          originalModel.modelId,
          candidate.model.modelId,
          candidate.fallback ? 1 : 0,
          candidate.fallback ? 1 : 0,
          candidate.model.pricing ? 'known' : 'unknown',
        );
      budget.requests += 1;

      try {
        const effectiveModel = maxOutputTokensPerTurn
          ? { ...candidate.model, params: { ...(candidate.model.params ?? {}), maxTokens: maxOutputTokensPerTurn } }
          : candidate.model;
        const result = await callModel({
          modelConfig: effectiveModel,
          messages,
          caseMeta,
          variantLabel,
          attemptNumber,
          turnIndex,
          signal: controller.signal,
          fetchImpl,
          promptText: messages[messages.length - 1]?.content ?? '',
          caseInput,
        });
        const cost = computeUsageCost(result.usage, candidate.model.pricing);
        budget.tokens += (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);
        if (cost.amount !== null) budget.amountKnown = Number(addAmounts(String(budget.amountKnown), cost.amount) ?? budget.amountKnown);
        else budget.amountUnknown = true;

        const responseRef = putObject(
          ctx.root,
          `${JSON.stringify({ content: result.content, finishReason: result.finishReason, usage: result.usage }, null, 2)}\n`,
        ).ref;
        ctx.db
          .prepare('UPDATE attempts SET status = ?, finished_at = ?, response_ref = ?, normalized_usage_json = ? WHERE id = ?')
          .run('succeeded', nowIso(), responseRef, JSON.stringify(result.usage), attemptId);
        return { result, model: candidate.model, attemptId, fallback: candidate.fallback };
      } catch (error) {
        const aborted = controller.signal.aborted || error.name === 'AbortError';
        ctx.db
          .prepare('UPDATE attempts SET status = ?, finished_at = ?, error_json = ? WHERE id = ?')
          .run(
            aborted ? 'canceled' : 'failed',
            nowIso(),
            JSON.stringify({ code: error.code ?? 'PROVIDER_UNAVAILABLE', retryable: Boolean(error.retryable), message: error.message }),
            attemptId,
          );
        if (aborted) throw dialogueStop('canceled');
        if (error.code === 'PROVIDER_POLICY_BLOCKED') {
          const policyError = createError('PROVIDER_POLICY_BLOCKED', { message: error.message });
          policyError.dialogueStop = 'policy_blocked';
          throw policyError;
        }
        lastError = error;
        if (!Boolean(error.retryable) || localAttempt >= snapshot.execution.maxAttempts) break;
        const waitMs = computeBackoffMs({
          baseMs: snapshot.execution.backoffBaseMs,
          maxMs: snapshot.execution.maxBackoffMs,
          attempt: localAttempt,
          retryAfterMs: error.details?.retryAfterMs ?? 0,
        });
        ctx.db.prepare('UPDATE trials SET trial_status = ?, updated_at = ? WHERE id = ?').run('retrying', nowIso(), trial.id);
        try {
          await sleep(waitMs, controller.signal);
        } catch {
          throw dialogueStop('canceled');
        }
      }
    }
  }
  throw lastError ?? createError('PROVIDER_UNAVAILABLE', { message: '对话模型调用失败。' });
}

function dialogueStop(reason) {
  const error = new Error(reason);
  error.dialogueStop = reason;
  return error;
}

function buildGeneratorMessages(system, caseInput, conversation, round) {
  const transcript = conversation.length
    ? conversation.map((message) => `${message.role === 'assistant' ? '模型 A' : '模型 B'}: ${message.content}`).join('\n')
    : '';
  const instruction = round === 1 ? '请生成第一条用户输入。' : '请基于当前对话生成下一条追问；若无需继续，请输出 <END>。';
  return [
    { role: 'system', content: system },
    { role: 'user', content: `测试用例输入：\n${caseInput}\n\n当前对话：\n${transcript || '（尚无对话）'}\n\n${instruction}` },
  ];
}

function matchTermination(termination, content) {
  for (const item of termination ?? []) {
    if (!item) continue;
    if (item.type === 'literal' && content.includes(item.value)) return { reason: 'termination_literal' };
    if (item.type === 'regex') {
      try {
        if (new RegExp(item.value).test(content)) return { reason: 'termination_regex' };
      } catch {
        /* 校验阶段已拦截 */
      }
    }
    if (item.type === 'json_condition') {
      let payload;
      let condition;
      try {
        payload = JSON.parse(content);
        condition = JSON.parse(item.value);
      } catch {
        continue;
      }
      if (matchesJsonCondition(payload, condition)) return { reason: 'termination_json_condition' };
    }
  }
  return null;
}

function matchesJsonCondition(payload, condition) {
  if (!condition || typeof condition !== 'object') return false;
  const actual = condition.path
    ? String(condition.path).split('.').reduce((value, key) => (value == null ? undefined : value[key]), payload)
    : payload;
  if (Object.prototype.hasOwnProperty.call(condition, 'equals')) {
    return JSON.stringify(actual) === JSON.stringify(condition.equals);
  }
  if (Object.prototype.hasOwnProperty.call(condition, 'truthy')) {
    return Boolean(actual) === Boolean(condition.truthy);
  }
  return false;
}

function checkBudget(budget, snapshot) {
  const limit = budget.limit ?? {};
  if (limit.maxRequests && budget.requests >= limit.maxRequests) return 'request_limit';
  if (limit.maxTotalTokens && budget.tokens >= limit.maxTotalTokens) return 'budget_exceeded';
  if (limit.maxDurationSeconds && budget.startedAt && Date.now() - budget.startedAt >= limit.maxDurationSeconds * 1000) return 'duration_exceeded';
  if (limit.maxAmount && budget.amountKnown >= Number(limit.maxAmount.amount)) return 'budget_exceeded';
  return null;
}

function normalizeOutput(result, testCase) {
  const content = String(result.content ?? '');
  if (!content.trim()) return 'invalid_empty';
  if (result.finishReason === 'length') return 'invalid_truncated';
  const needsJson = testCase.meta?.outputFormat === 'json' || testCase.meta?.expectJson === true;
  if (needsJson) {
    try {
      JSON.parse(content);
    } catch {
      return 'invalid_format';
    }
  }
  return 'valid';
}

function markTrial(ctx, trialId, update) {
  const fields = [];
  const values = [];
  const set = (column, value) => {
    fields.push(`${column} = ?`);
    values.push(value);
  };
  if (update.trialStatus) set('trial_status', update.trialStatus);
  if (update.outputValidity) set('output_validity', update.outputValidity);
  if (update.evaluationStatus) set('evaluation_status', update.evaluationStatus);
  if (update.output !== undefined) set('output_json', update.output ? JSON.stringify(update.output) : null);
  if (update.reasons) set('ineligibility_reasons_json', JSON.stringify(update.reasons));
  if (update.eligible !== undefined) set('comparison_eligible', update.eligible ? 1 : 0);
  if (update.truncated !== undefined) set('truncated', update.truncated ? 1 : 0);
  set('updated_at', nowIso());
  values.push(trialId);
  ctx.db.prepare(`UPDATE trials SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function countTrials(ctx, runId) {
  return Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM trials WHERE run_id = ?').get(runId).n);
}

function countTrialsByStatus(ctx, runId) {
  const rows = ctx.db.prepare('SELECT trial_status, COUNT(*) AS n FROM trials WHERE run_id = ? GROUP BY trial_status').all(runId);
  const counts = { queued: 0, running: 0, retrying: 0, completed: 0, failed: 0, canceled: 0, abortedUnknown: 0 };
  for (const row of rows) {
    if (row.trial_status === 'aborted_unknown') counts.abortedUnknown = Number(row.n);
    else counts[row.trial_status] = Number(row.n);
  }
  return counts;
}

async function runPool(items, concurrency, worker) {
  const size = Math.max(1, Math.min(concurrency ?? 1, items.length || 1));
  let cursor = 0;
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export function getRun(ctx, runId, { includeOutputs = false } = {}) {
  const run = ctx.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) throw createError('NOT_FOUND_RUN', { message: `运行不存在: ${runId}` });
  const trialRows = ctx.db.prepare('SELECT * FROM trials WHERE run_id = ? ORDER BY created_at, id').all(runId);
  const turnRows = ctx.db
    .prepare(
      `SELECT dt.* FROM dialogue_turns dt JOIN trials t ON t.id = dt.trial_id
       WHERE t.run_id = ? ORDER BY dt.round, dt.created_at, dt.id`,
    )
    .all(runId);
  const turnsByTrial = new Map();
  for (const row of turnRows) {
    const list = turnsByTrial.get(row.trial_id) ?? [];
    list.push(mapDialogueTurn(row));
    turnsByTrial.set(row.trial_id, list);
  }
  const trials = trialRows.map((trial) => mapTrial(ctx, trial, turnsByTrial.get(trial.id) ?? []));
  const counts = buildCounts(trials);
  const data = {
    run: {
      id: run.id,
      projectId: run.project_id,
      snapshotId: run.snapshot_id,
      snapshotHash: run.snapshot_hash,
      status: run.status,
      ...(run.parent_run_id ? { parentRunId: run.parent_run_id } : {}),
      ...(run.stop_reason ? { stopReason: run.stop_reason } : { stopReason: undefined }),
      createdAt: run.created_at,
      ...(run.started_at ? { startedAt: run.started_at } : {}),
      ...(run.finished_at ? { finishedAt: run.finished_at } : {}),
      updatedAt: run.updated_at,
    },
    counts,
    trials,
  };
  if (includeOutputs) {
    data.outputs = Object.fromEntries(
      trialRows
        .filter((trial) => trial.output_json)
        .map((trial) => [trial.id, JSON.parse(trial.output_json)]),
    );
    data.events = ctx.db.prepare('SELECT seq, type, payload_json, created_at FROM run_events WHERE run_id = ? ORDER BY seq').all(runId).map((event) => ({
      seq: event.seq,
      type: event.type,
      payload: event.payload_json ? JSON.parse(event.payload_json) : null,
      createdAt: event.created_at,
    }));
  }
  return data;
}

function mapTrial(ctx, trial, dialogueTurns = []) {
  const attempts = ctx.db.prepare('SELECT * FROM attempts WHERE trial_id = ? ORDER BY attempt_number').all(trial.id);
  return {
    id: trial.id,
    runId: trial.run_id,
    variantVersionId: trial.variant_version_id,
    caseVersionId: trial.case_version_id,
    modelConfigVersionId: trial.model_config_version_id,
    repetitionIndex: trial.repetition_index,
    idempotencyKey: trial.idempotency_key,
    trialStatus: trial.trial_status,
    outputValidity: trial.output_validity,
    evaluationStatus: trial.evaluation_status,
    comparisonEligible: Boolean(trial.comparison_eligible),
    ineligibilityReasons: JSON.parse(trial.ineligibility_reasons_json ?? '[]'),
    truncated: Boolean(trial.truncated),
    ...(dialogueTurns.length ? { dialogueTurns } : {}),
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      trialId: attempt.trial_id,
      attemptNumber: attempt.attempt_number,
      status: attempt.status,
      startedAt: attempt.started_at,
      ...(attempt.finished_at ? { finishedAt: attempt.finished_at } : {}),
      originalModelConfigVersionId: attempt.original_model_config_version_id,
      actualModelConfigVersionId: attempt.actual_model_config_version_id,
      originalModelId: attempt.original_model_id,
      actualModelId: attempt.actual_model_id,
      fallbackUsed: Boolean(attempt.fallback_used),
      crossModelSubstitution: Boolean(attempt.cross_model_substitution),
      billingState: attempt.billing_state,
      ...(attempt.response_ref ? { responseRef: attempt.response_ref } : {}),
      ...(attempt.normalized_usage_json ? { normalizedUsage: JSON.parse(attempt.normalized_usage_json) } : {}),
      ...(attempt.error_json ? { error: JSON.parse(attempt.error_json) } : {}),
    })),
  };
}

function mapDialogueTurn(row) {
  return {
    id: row.id,
    trialId: row.trial_id,
    round: row.round,
    role: row.role,
    modelConfigVersionId: row.model_config_version_id,
    modelId: row.model_id,
    content: row.content,
    usage: row.usage_json ? JSON.parse(row.usage_json) : null,
    terminationReason: row.termination_reason,
    createdAt: row.created_at,
  };
}

function buildCounts(trials) {
  const counts = {
    total: trials.length,
    queued: 0,
    running: 0,
    retrying: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    abortedUnknown: 0,
    outputValid: 0,
    outputInvalid: 0,
    comparisonEligible: 0,
    fallbackUsed: 0,
  };
  for (const trial of trials) {
    if (trial.trialStatus === 'aborted_unknown') counts.abortedUnknown++;
    else counts[trial.trialStatus] = (counts[trial.trialStatus] ?? 0) + 1;
    if (trial.outputValidity === 'valid') counts.outputValid++;
    else if (trial.outputValidity !== 'not_available') counts.outputInvalid++;
    if (trial.comparisonEligible) counts.comparisonEligible++;
    if (trial.attempts.some((attempt) => attempt.fallbackUsed)) counts.fallbackUsed++;
  }
  return counts;
}

export function cancelRun(ctx, runId, { modelConfigVersionId = null } = {}) {
  const run = ctx.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) throw createError('NOT_FOUND_RUN', { message: `运行不存在: ${runId}` });
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    throw createError('STATE_INVALID_TRANSITION', { message: `运行已结束（${run.status}），不能取消。` });
  }
  if (modelConfigVersionId) {
    const group = ctx.db.prepare('SELECT COUNT(*) AS n FROM trials WHERE run_id = ? AND model_config_version_id = ?').get(runId, modelConfigVersionId);
    if (!Number(group.n)) {
      throw createError('VALIDATION_INVALID_REQUEST', { message: `该模型不在本次运行中: ${modelConfigVersionId}`, details: { runId, modelConfigVersionId } });
    }
    const canceled = ctx.db
      .prepare("UPDATE trials SET trial_status = 'canceled', ineligibility_reasons_json = ?, updated_at = ? WHERE run_id = ? AND model_config_version_id = ? AND trial_status = 'queued'")
      .run(JSON.stringify(['canceled_model_group']), nowIso(), runId, modelConfigVersionId);
    const remaining = Number(
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM trials WHERE run_id = ? AND trial_status IN ('queued','running','retrying')")
        .get(runId).n,
    );
    if (remaining === 0 && run.status === 'queued') {
      ctx.db.prepare('UPDATE runs SET status = ?, stop_reason = ?, finished_at = ?, updated_at = ? WHERE id = ?').run('canceled', 'model_group_canceled', nowIso(), nowIso(), runId);
    } else if (remaining === 0) {
      ctx.db.prepare('UPDATE runs SET stop_reason = ?, updated_at = ? WHERE id = ?').run('model_group_canceled', nowIso(), runId);
    }
    appendEvent(ctx, runId, 'model_group_canceled', { modelConfigVersionId, canceledTrials: canceled.changes, remaining });
    recordAudit(ctx, 'run.model_group_canceled', { runId, modelConfigVersionId, canceledTrials: canceled.changes, remaining });
    return {
      runId,
      modelConfigVersionId,
      canceledTrials: canceled.changes,
      remaining,
      status: ctx.db.prepare('SELECT status FROM runs WHERE id = ?').get(runId).status,
    };
  }
  if (run.status === 'queued') {
    ctx.db.prepare('UPDATE runs SET status = ?, stop_reason = ?, finished_at = ?, updated_at = ? WHERE id = ?').run('canceled', 'user_cancel', nowIso(), nowIso(), runId);
    ctx.db.prepare("UPDATE trials SET trial_status = 'canceled', ineligibility_reasons_json = '[\"canceled\"]', updated_at = ? WHERE run_id = ? AND trial_status = 'queued'").run(nowIso(), runId);
  } else {
    ctx.db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?').run('cancel_requested', nowIso(), runId);
  }
  appendEvent(ctx, runId, 'cancel_requested', { previousStatus: run.status });
  recordAudit(ctx, 'run.cancel_requested', { runId, previousStatus: run.status });
  return { runId, status: run.status === 'queued' ? 'canceled' : 'cancel_requested' };
}

export async function waitRun(ctx, runId, { timeoutMs = 600_000, pollMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = ctx.db.prepare('SELECT status FROM runs WHERE id = ?').get(runId);
    if (!row) throw createError('NOT_FOUND_RUN', { message: `运行不存在: ${runId}` });
    if (TERMINAL_RUN_STATUSES.has(row.status)) return { runId, status: row.status, timedOut: false };
    if (Date.now() >= deadline) return { runId, status: row.status, timedOut: true };
    await sleep(pollMs);
  }
}

export function appendEvent(ctx, runId, type, payload) {
  transaction(ctx.db, () => appendEventInTx(ctx, runId, type, payload));
}

function appendEventInTx(ctx, runId, type, payload) {
  const seq = Number(ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM run_events WHERE run_id = ?').get(runId).n) + 1;
  ctx.db
    .prepare('INSERT INTO run_events(id, run_id, seq, type, payload_json, created_at) VALUES(?,?,?,?,?,?)')
    .run(ulid(), runId, seq, type, payload ? JSON.stringify(payload) : null, nowIso());
}

export function runSummaryForReport(ctx, runId) {
  const run = ctx.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) throw createError('NOT_FOUND_RUN', { message: `运行不存在: ${runId}` });
  const data = getRun(ctx, runId, { includeOutputs: true });
  const snapshot = loadSnapshot(ctx, run.snapshot_id);
  const attempts = ctx.db
    .prepare(
      `SELECT a.*, t.id AS trial_id, t.case_version_id, t.variant_version_id, t.model_config_version_id
       FROM attempts a JOIN trials t ON t.id = a.trial_id WHERE t.run_id = ? ORDER BY a.started_at, a.attempt_number`,
    )
    .all(runId);
  return { run, data, snapshot, attempts, evaluationVersion: evaluationVersionForRun(ctx, runId) };
}

export { trialCount, hashJson, hashText };
