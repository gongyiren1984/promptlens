import { createError } from './errors.js';
import { addVariant, diffLines, getPromptVersion } from './assets.js';
import { callModel, computeUsageCost, findModelByName, getModelConfigVersion } from './models.js';
import { loadSnapshot } from './spec.js';
import { createRun, executeRun } from './run.js';
import { finalizeRunArtifacts } from './auto-report.js';
import { spawnRunWorker } from './worker.js';
import { nowIso } from './time.js';

const MAX_EVIDENCE = 8;
const MAX_ROUNDS = 3;

/**
 * 基于一次运行的可比证据，让模型提出提示词改进稿。
 * 只生成候选与行级 diff；写入新版本必须显式 save=true，且由用户确认。
 * rounds>1 时逐轮在前一轮候选上继续改进，每轮独立保存与验证。
 */
export async function proposePromptIteration(
  ctx,
  { runId, modelConfigVersionId = null, modelRef = null, promptVersionId = null, instruction = '', label = null, rounds = 1, save = false, verify = false, inline = false, signal = null, fetchImpl = null } = {},
) {
  if (verify && !save) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: 'verify 需要 save=true；未保存的候选无法创建验证 Run。' });
  }
  const roundCount = clampRounds(rounds);
  requireFinishedRun(ctx, runId);
  const modelConfig = resolveModel(ctx, modelConfigVersionId ?? modelRef);
  const variantMeans = loadVariantMeans(ctx, runId);
  if (!variantMeans.length) {
    throw createError('STATE_EVIDENCE_MISSING', { message: '该运行没有可比的已评估 Trial，无法生成迭代建议。' });
  }

  const base = promptVersionId ? getBaseVersion(ctx, promptVersionId, runId) : getPromptVersion(ctx, variantMeans[0].version_id);
  const evidence = loadEvidence(ctx, runId);
  const started = Date.now();
  const candidates = [];
  let previous = null;

  for (let round = 1; round <= roundCount; round++) {
    const sourceContent = previous ?? base.content;
    let proposalText;
    let rationale;
    let usage = null;
    if (modelConfig.providerType === 'mock') {
      proposalText = mockProposal(sourceContent, instruction, round);
      rationale = `mock 模型第 ${round} 轮：在保持变量占位符不变的前提下，补充“${instruction || roundRequirement(round)}”。真实模型会结合逐条低分证据改写。`;
    } else {
      const messages = buildIterationMessages({
        base: { ...base, content: sourceContent, label: round === 1 ? base.label : `${base.label} · R${round}` },
        variantMeans,
        evidence,
        instruction: round === 1 ? instruction : `${instruction || '继续改进'}（第 ${round} 轮，在上一轮候选基础上继续）`,
      });
      const result = await callModel({
        modelConfig,
        messages,
        caseMeta: null,
        variantLabel: base.label,
        attemptNumber: round,
        signal,
        fetchImpl,
        promptText: messages.map((message) => message.content).join('\n'),
        caseInput: { runId, round },
      });
      proposalText = stripFences(result.content);
      rationale = extractRationale(result.content);
      usage = result.usage ?? null;
    }
    if (!proposalText.trim()) {
      throw createError('PROVIDER_INVALID_REQUEST', { message: '模型没有返回可用的提示词文本。' });
    }
    candidates.push({
      round,
      content: proposalText,
      rationale,
      usage,
      label: candidateLabel(base.label, label, round, roundCount),
      diff: { identical: base.content === proposalText, lines: diffLines(base.content, proposalText) },
    });
    previous = proposalText;
  }

  let savedCandidates = [];
  if (save) {
    if (!ctx.db.prepare('SELECT 1 FROM prompts WHERE id = ?').get(base.promptId)) {
      throw createError('NOT_FOUND_PROMPT_VERSION', { message: `提示词不存在: ${base.promptId}` });
    }
    savedCandidates = candidates.map((candidate) => {
      const saved = addVariant(ctx, { promptId: base.promptId, label: candidate.label, content: candidate.content });
      return { ...candidate, saved };
    });
  }

  let verification = [];
  if (verify) {
    verification = await verifyIterationCandidates(ctx, {
      runId,
      baseVersionId: base.versionId,
      candidates: savedCandidates.map((candidate) => ({
        round: candidate.round,
        versionId: candidate.saved.versionId,
        label: candidate.saved.label,
        contentHash: candidate.saved.contentHash,
      })),
      inline,
    });
  }

  const first = savedCandidates[0] ?? candidates[0];
  const costs = candidates.map((candidate) =>
    candidate.usage ? computeUsageCost(candidate.usage, modelConfig.pricing) : { amount: null, currency: null, billingState: 'not_billed' },
  );
  const cost = aggregateCosts(costs);

  return {
    runId,
    base: {
      versionId: base.versionId,
      promptId: base.promptId,
      promptName: base.promptName,
      label: base.label,
      versionNumber: base.versionNumber,
      content: base.content,
      contentHash: base.contentHash,
    },
    proposal: {
      content: first.content,
      rationale: first.rationale,
      label: first.label,
      created: first.saved?.created ?? false,
      versionId: first.saved?.versionId ?? null,
      versionNumber: first.saved?.versionNumber ?? null,
    },
    rounds: savedCandidates.length
      ? savedCandidates.map((candidate) => ({
          round: candidate.round,
          content: candidate.content,
          rationale: candidate.rationale,
          label: candidate.label,
          diff: candidate.diff,
          saved: candidate.saved,
          verification: verification.find((item) => item.round === candidate.round) ?? unverified(),
        }))
      : candidates.map((candidate) => ({
          round: candidate.round,
          content: candidate.content,
          rationale: candidate.rationale,
          label: candidate.label,
          diff: candidate.diff,
          saved: null,
          verification: unverified(),
        })),
    diff: first.diff,
    evidence: {
      variants: variantMeans.map((item) => ({
        versionId: item.version_id,
        label: item.label,
        meanScore: round3(item.mean),
        trials: Number(item.n),
      })),
      lowScores: evidence,
    },
    generator: {
      modelConfigVersionId: modelConfig.modelConfigVersionId,
      name: modelConfig.name,
      providerType: modelConfig.providerType,
      instruction: String(instruction ?? ''),
      rounds: roundCount,
      generatedAt: nowIso(),
      latencyMs: Date.now() - started,
    },
    cost,
    costs,
    usage: candidates[candidates.length - 1]?.usage ?? null,
    saved: first.saved ?? null,
    verification,
  };
}

/** 生成前的证据、模型、成本与轮数预览。 */
export function buildIterationContext(ctx, { runId, modelConfigVersionId = null, modelRef = null, promptVersionId = null, rounds = 1 } = {}) {
  requireFinishedRun(ctx, runId);
  const modelConfig = resolveModel(ctx, modelConfigVersionId ?? modelRef);
  const variantMeans = loadVariantMeans(ctx, runId);
  if (!variantMeans.length) {
    throw createError('STATE_EVIDENCE_MISSING', { message: '该运行没有可比的已评估 Trial，无法生成迭代建议。' });
  }
  const base = promptVersionId ? getBaseVersion(ctx, promptVersionId, runId) : getPromptVersion(ctx, variantMeans[0].version_id);
  const evidence = loadEvidence(ctx, runId);
  const roundCount = clampRounds(rounds);
  return {
    runId,
    base: {
      versionId: base.versionId,
      label: base.label,
      versionNumber: base.versionNumber,
      promptName: base.promptName,
      contentHash: base.contentHash,
    },
    generator: {
      modelConfigVersionId: modelConfig.modelConfigVersionId,
      name: modelConfig.name,
      providerType: modelConfig.providerType,
      pricing: modelConfig.pricing ?? null,
    },
    rounds: { requested: roundCount, max: MAX_ROUNDS },
    evidence: {
      variants: variantMeans.map((item) => ({
        versionId: item.version_id,
        label: item.label,
        meanScore: round3(item.mean),
        trials: Number(item.n),
      })),
      lowScores: evidence,
    },
    cost: estimateIterationCost(modelConfig, roundCount),
    verification: {
      requiresSave: true,
      inlineSupported: true,
      note: '保存候选后会按原测试集、模型、评分方案与重复次数各创建一个验证 Run，并自动生成报告版本。',
    },
  };
}

/** 按源运行快照派生验证规格：基准分支与候选分支同台 A/B。 */
export function deriveVerificationSpec(snapshot, { baseVersionId, candidateVersionId, candidateLabel, candidateContentHash, round = 1 }) {
  const base = snapshot.variants.find((variant) => variant.promptVersionId === baseVersionId);
  if (!base) throw createError('VALIDATION_INVALID_REQUEST', { message: `基准分支不在源运行快照中: ${baseVersionId}` });
  const dialogue = snapshot.spec.execution?.dialogue;
  const callsPerTrial = dialogue
    ? dialogue.maxRounds + (dialogue.initialInputPolicy === 'case_first' ? dialogue.maxRounds - 1 : dialogue.maxRounds)
    : 1;
  const trialCount = 2 * snapshot.testSet.cases.length * snapshot.spec.models.length * snapshot.repetitions;
  return {
    ...snapshot.spec,
    name: `${snapshot.spec.name} · 迭代验证 R${round}`,
    variants: [
      { label: base.label, promptVersionId: base.promptVersionId, contentHash: base.contentHash },
      { label: candidateLabel, promptVersionId: candidateVersionId, contentHash: candidateContentHash },
    ],
    budget: { maxRequests: Math.max(1, trialCount * callsPerTrial) },
  };
}

async function verifyIterationCandidates(ctx, { runId, baseVersionId, candidates, inline = false }) {
  const run = ctx.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  const snapshot = loadSnapshot(ctx, run.snapshot_id);
  const results = [];
  for (const candidate of candidates) {
    const spec = deriveVerificationSpec(snapshot, {
      baseVersionId,
      candidateVersionId: candidate.versionId,
      candidateLabel: candidate.label,
      candidateContentHash: candidate.contentHash,
      round: candidate.round,
    });
    const created = await createRun(ctx, spec, { idempotencyKey: `iteration:${runId}:${candidate.versionId}`, parentRunId: runId });
    let status = created.status ?? 'queued';
    let reportId = null;
    if (inline) {
      const executed = await executeRun(ctx, created.runId);
      status = executed.status ?? status;
      const artifacts = finalizeRunArtifacts(ctx, created.runId);
      reportId = artifacts.reportId ?? null;
    } else {
      spawnRunWorker(ctx.root, created.runId);
    }
    results.push({
      round: candidate.round,
      candidateVersionId: candidate.versionId,
      candidateLabel: candidate.label,
      runId: created.runId,
      reportId,
      status,
      detached: !inline,
      verificationStatus: 'unverified',
    });
  }
  return results;
}

export function buildIterationMessages({ base, variantMeans, evidence, instruction }) {
  const means = variantMeans.map((item) => `- ${item.label}: 均值 ${round3(item.mean)}（${item.n} 个 Trial）`).join('\n');
  const failures = evidence
    .map((item, index) => `${index + 1}. [${item.variantLabel} 得分 ${item.score}]\n输入：${JSON.stringify(item.input)}\n输出：${JSON.stringify(item.output)}`)
    .join('\n\n');
  return [
    {
      role: 'system',
      content:
        '你是提示词工程师。基于评测证据改进提示词。必须保留原有变量占位符（如 {{question}}）与输出格式要求；不要编造事实；优先修复低分用例暴露的问题。先输出一行“理由：...”，再输出改进后的完整提示词。不要使用 Markdown 代码围栏。',
    },
    {
      role: 'user',
      content: `当前提示词（分支 ${base.label}，v${base.versionNumber}）：
---
${base.content}
---

各分支均值：
${means}

低分证据：
${failures || '（无）'}

改进要求：${instruction || '在不改变任务目标的前提下，提高一致性与边界处理。'}

请给出改进后的完整提示词。`,
    },
  ];
}

function requireFinishedRun(ctx, runId) {
  const run = ctx.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) throw createError('NOT_FOUND_RUN', { message: `运行不存在: ${runId}` });
  if (run.status === 'queued' || run.status === 'running' || run.status === 'cancel_requested') {
    throw createError('STATE_INVALID_TRANSITION', { message: '运行尚未结束，暂时没有完整证据可用于迭代。' });
  }
  return run;
}

function loadVariantMeans(ctx, runId) {
  return ctx.db
    .prepare(
      `SELECT pv.id AS version_id, v.prompt_id, pv.content, v.label, AVG(e.overall_score) AS mean, COUNT(*) AS n
       FROM trials t
       JOIN evaluations e ON e.trial_id = t.id
       JOIN prompt_versions pv ON pv.id = t.variant_version_id
       JOIN prompt_variants v ON v.id = pv.variant_id
       WHERE t.run_id = ? AND t.comparison_eligible = 1 AND e.status = 'completed' AND e.overall_score IS NOT NULL
       GROUP BY pv.id
       ORDER BY mean ASC`,
    )
    .all(runId);
}

function getBaseVersion(ctx, versionId, runId) {
  const version = getPromptVersion(ctx, versionId);
  const used = ctx.db
    .prepare('SELECT 1 FROM trials WHERE run_id = ? AND variant_version_id = ? LIMIT 1')
    .get(runId, versionId);
  if (!used) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: '所选提示词版本未参与该运行，证据不可比。' });
  }
  return version;
}

function loadEvidence(ctx, runId) {
  const rows = ctx.db
    .prepare(
      `SELECT t.variant_version_id, t.output_json, c.input_json, e.overall_score, v.label
       FROM trials t
       JOIN evaluations e ON e.trial_id = t.id
       JOIN prompt_versions pv ON pv.id = t.variant_version_id
       JOIN prompt_variants v ON v.id = pv.variant_id
       LEFT JOIN cases c ON c.id = t.case_version_id
       WHERE t.run_id = ? AND t.comparison_eligible = 1 AND e.status = 'completed' AND e.overall_score IS NOT NULL
       ORDER BY e.overall_score ASC, t.id ASC
       LIMIT ?`,
    )
    .all(runId, MAX_EVIDENCE);
  return rows.map((row) => ({
    variantLabel: row.label,
    score: round3(row.overall_score),
    input: safeJson(row.input_json),
    output: safeJson(row.output_json),
  }));
}

function clampRounds(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return 1;
  return Math.min(MAX_ROUNDS, number);
}

function candidateLabel(baseLabel, label, round, rounds) {
  const requested = String(label ?? '').trim();
  const stem = requested || `${baseLabel}-iter`;
  const resolved = rounds > 1 ? `${stem}-r${round}` : stem;
  return resolved === baseLabel ? `${resolved}-iter` : resolved;
}

function roundRequirement(round) {
  return ['针对低分用例补齐边界条件与输出约束', '逐条核对输入事实，信息不足时明确说明缺少什么', '先给出结论再解释依据，避免过度承诺'][(round - 1) % 3];
}

function mockProposal(content, instruction, round = 1) {
  const requirement = String(instruction ?? '').trim() || roundRequirement(round);
  return `${content.trimEnd()}\n\n补充要求：${requirement}。回答前先核对输入中的关键事实；信息不足时说明缺少什么，不要猜测。`;
}

function stripFences(text) {
  const raw = String(text ?? '').trim();
  const fenced = /```(?:markdown|text)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;
  return body.split('\n').filter((line, index) => !(index === 0 && /^理由[:：]/.test(line.trim()))).join('\n').trim();
}

function extractRationale(text) {
  const match = /理由[:：]\s*(.+)/.exec(String(text ?? ''));
  return match ? match[1].trim() : null;
}

function resolveModel(ctx, ref) {
  if (!ref) throw createError('VALIDATION_INVALID_REQUEST', { message: '请选择用于生成改进稿的模型。' });
  try {
    return getModelConfigVersion(ctx, ref);
  } catch (error) {
    if (error.code !== 'NOT_FOUND_MODEL') throw error;
    return findModelByName(ctx, ref);
  }
}

function estimateIterationCost(modelConfig, rounds) {
  const pricing = modelConfig.pricing;
  if (!pricing) {
    return { amount: null, currency: null, completeness: 'unknown', rounds, note: '模型价格未知，实际成本以 Attempt 记录为准，不按 0 计。' };
  }
  if (pricing.unit === 'per_request' && pricing.perRequest != null) {
    return {
      amount: String(Number((Number(pricing.perRequest) * rounds).toFixed(10))),
      currency: pricing.currency,
      completeness: 'complete',
      rounds,
    };
  }
  return { amount: null, currency: pricing.currency ?? null, completeness: 'usage_based', rounds, note: '按 Token 计价的模型无法在生成前精确预估，实际用量以 Attempt 记录为准。' };
}

function aggregateCosts(costs) {
  if (!costs.length) return { amount: null, currency: null, billingState: 'unknown' };
  let amount = 0;
  let currency = null;
  let unknown = false;
  for (const cost of costs) {
    if (cost.amount == null) unknown = true;
    else {
      amount += Number(cost.amount);
      currency = cost.currency ?? currency;
    }
  }
  if (unknown && costs.every((cost) => cost.amount == null)) return { amount: null, currency, billingState: 'unknown' };
  return { amount: amount.toFixed(10).replace(/0+$/, '').replace(/\.$/, '') || '0', currency, billingState: unknown ? 'partial' : 'known' };
}

function unverified() {
  return { status: 'unverified', runId: null, reportId: null };
}

function safeJson(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function round3(value) {
  return value === null || value === undefined ? null : Math.round(Number(value) * 1000) / 1000;
}
