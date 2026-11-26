import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { parseYaml } from './yaml.js';
import { createError } from './errors.js';
import { hashJson, hashText, canonicalJson } from './hash.js';
import { ulid } from './ids.js';
import { nowIso } from './time.js';
import { getPromptVersion } from './assets.js';
import { getTestSetVersion } from './cases.js';
import { getModelConfigVersion, modelAdapterInfo } from './models.js';
import { getEvaluationProfileVersion, validateEvaluationConfig, normalizedWeights } from '../eval/profile.js';
import { putObject, getObject } from './objects.js';
import { SERVER_VERSION } from '../version.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MONEY_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/;

export function loadSpecFile(path) {
  if (!existsSync(path)) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: `实验规格文件不存在: ${path}` });
  }
  const text = readFileSync(path, 'utf8');
  const ext = extname(path).toLowerCase();
  try {
    if (ext === '.json') return JSON.parse(text);
    if (ext === '.yaml' || ext === '.yml') return parseYaml(text);
  } catch (error) {
    throw createError('VALIDATION_SCHEMA_INVALID', { message: `实验规格解析失败: ${error.message}` });
  }
  throw createError('VALIDATION_UNSUPPORTED_FORMAT', { message: '实验规格仅支持 .json / .yaml / .yml。' });
}

export function validateSpecShape(spec, { projectId } = {}) {
  const errors = [];
  const need = (condition, path, message) => {
    if (!condition) errors.push({ path, message });
  };
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw createError('VALIDATION_SCHEMA_INVALID', { message: '实验规格必须是对象。' });
  }
  need(spec.schema === 'promptlens.experiment/v1', 'schema', '必须是 promptlens.experiment/v1');
  if (projectId) need(spec.projectId === projectId, 'projectId', `必须等于当前项目 ${projectId}`);
  need(typeof spec.name === 'string' && spec.name.trim(), 'name', '不能为空');

  const variants = Array.isArray(spec.variants) ? spec.variants : [];
  need(variants.length >= 2 && variants.length <= 20, 'variants', '需要 2—20 个分支');
  const labels = new Set();
  variants.forEach((variant, index) => {
    need(typeof variant?.label === 'string' && variant.label.trim(), `variants[${index}].label`, '不能为空');
    need(typeof variant?.promptVersionId === 'string' && ID_PATTERN.test(variant.promptVersionId), `variants[${index}].promptVersionId`, '格式非法');
    need(typeof variant?.contentHash === 'string' && HASH_PATTERN.test(variant.contentHash), `variants[${index}].contentHash`, '格式非法');
    if (variant?.label) {
      need(!labels.has(variant.label), `variants[${index}].label`, '分支标签重复');
      labels.add(variant.label);
    }
  });

  need(spec.testSet && typeof spec.testSet === 'object', 'testSet', '必须提供测试集');
  if (spec.testSet && typeof spec.testSet === 'object') {
    need(typeof spec.testSet.testSetVersionId === 'string' && ID_PATTERN.test(spec.testSet.testSetVersionId), 'testSet.testSetVersionId', '格式非法');
    need(typeof spec.testSet.contentHash === 'string' && HASH_PATTERN.test(spec.testSet.contentHash), 'testSet.contentHash', '格式非法');
    if (spec.testSet.sampleSize !== undefined) need(Number.isInteger(spec.testSet.sampleSize) && spec.testSet.sampleSize > 0, 'testSet.sampleSize', '必须为正整数');
    if (spec.testSet.samplingSeed !== undefined) need(Number.isInteger(spec.testSet.samplingSeed) && spec.testSet.samplingSeed >= 0, 'testSet.samplingSeed', '必须为非负整数');
  }

  const models = Array.isArray(spec.models) ? spec.models : [];
  need(models.length >= 1 && models.length <= 32, 'models', '需要 1—32 个模型');
  models.forEach((model, index) => {
    need(typeof model?.modelConfigVersionId === 'string' && ID_PATTERN.test(model.modelConfigVersionId), `models[${index}].modelConfigVersionId`, '格式非法');
    need(typeof model?.modelProfileId === 'string' && ID_PATTERN.test(model.modelProfileId), `models[${index}].modelProfileId`, '格式非法');
    need(typeof model?.contentHash === 'string' && HASH_PATTERN.test(model.contentHash), `models[${index}].contentHash`, '格式非法');
    if (model?.fallbackModelConfigVersionIds !== undefined) {
      need(Array.isArray(model.fallbackModelConfigVersionIds), `models[${index}].fallbackModelConfigVersionIds`, '必须是数组');
      need((model.fallbackModelConfigVersionIds?.length ?? 0) <= 5, `models[${index}].fallbackModelConfigVersionIds`, '最多 5 个');
    }
  });

  need(Number.isInteger(spec.repetitions) && spec.repetitions >= 1 && spec.repetitions <= 20, 'repetitions', '必须是 1—20 的整数');

  const evaluation = spec.evaluation;
  need(evaluation && typeof evaluation === 'object', 'evaluation', '必须提供评分方案');
  if (evaluation && typeof evaluation === 'object') {
    need(typeof evaluation.profileVersionId === 'string' && ID_PATTERN.test(evaluation.profileVersionId), 'evaluation.profileVersionId', '格式非法');
    need(typeof evaluation.contentHash === 'string' && HASH_PATTERN.test(evaluation.contentHash), 'evaluation.contentHash', '格式非法');
    if (evaluation.judgeRepetitions !== undefined) {
      need(Number.isInteger(evaluation.judgeRepetitions) && evaluation.judgeRepetitions >= 1 && evaluation.judgeRepetitions <= 9, 'evaluation.judgeRepetitions', '必须是 1—9');
    }
  }

  const budget = spec.budget;
  need(budget && typeof budget === 'object', 'budget', '必须提供预算');
  if (budget && typeof budget === 'object') {
    const limits = ['maxRequests', 'maxTotalTokens', 'maxDurationSeconds', 'maxAmount'].filter((key) => budget[key] !== undefined);
    need(limits.length > 0, 'budget', '至少需要一个硬性限制（请求数/Token/时长/金额）');
    for (const key of ['maxRequests', 'maxTotalTokens', 'maxDurationSeconds']) {
      if (budget[key] !== undefined) need(Number.isInteger(budget[key]) && budget[key] > 0, `budget.${key}`, '必须为正整数');
    }
    if (budget.maxAmount !== undefined) {
      need(typeof budget.maxAmount === 'object', 'budget.maxAmount', '必须是 { amount, currency }');
      if (budget.maxAmount && typeof budget.maxAmount === 'object') {
        need(typeof budget.maxAmount.amount === 'string' && MONEY_PATTERN.test(budget.maxAmount.amount), 'budget.maxAmount.amount', '必须是十进制字符串');
        need(typeof budget.maxAmount.currency === 'string' && /^[A-Z]{3}$/.test(budget.maxAmount.currency), 'budget.maxAmount.currency', '必须是三位币种');
      }
    }
    if (budget.reservePercent !== undefined) {
      need(Number.isInteger(budget.reservePercent) && budget.reservePercent >= 0 && budget.reservePercent <= 50, 'budget.reservePercent', '必须是 0—50');
    }
  }

  if (spec.execution !== undefined) {
    const execution = spec.execution;
    need(execution && typeof execution === 'object', 'execution', '必须是对象');
    if (execution?.maxAttempts !== undefined) need(Number.isInteger(execution.maxAttempts) && execution.maxAttempts >= 1 && execution.maxAttempts <= 10, 'execution.maxAttempts', '必须是 1—10');
    if (execution?.maxConcurrency !== undefined) need(Number.isInteger(execution.maxConcurrency) && execution.maxConcurrency >= 1 && execution.maxConcurrency <= 256, 'execution.maxConcurrency', '必须是 1—256');
    if (execution?.order !== undefined) need(['sequential', 'seeded_random'].includes(execution.order), 'execution.order', '取值非法');
    if (execution?.dialogue !== undefined) validateDialogueShape(execution.dialogue, need);
  }

  if (errors.length) {
    throw createError('VALIDATION_SCHEMA_INVALID', {
      message: '实验规格未通过校验。',
      details: { errors, count: errors.length },
    });
  }
}

/** 解析全部引用并校验冻结哈希，任何漂移都阻断运行。 */
export function resolveReferences(ctx, spec) {
  const variants = spec.variants.map((variant) => {
    const version = getPromptVersion(ctx, variant.promptVersionId);
    if (hashText(version.content) !== variant.contentHash) {
      throw createError('VALIDATION_SCHEMA_INVALID', {
        message: `分支 ${variant.label} 的内容哈希与规格不一致。`,
        details: { expected: variant.contentHash, actual: hashText(version.content) },
      });
    }
    return {
      label: variant.label,
      promptVersionId: version.versionId,
      promptId: version.promptId,
      promptName: version.promptName,
      variantId: version.variantId,
      variantLabel: version.label,
      versionNumber: version.versionNumber,
      content: version.content,
      variables: version.variables,
      contentHash: version.contentHash,
    };
  });

  const testSetVersion = getTestSetVersion(ctx, spec.testSet.testSetVersionId);
  if (testSetVersion.contentHash !== spec.testSet.contentHash) {
    throw createError('VALIDATION_SCHEMA_INVALID', {
      message: '测试集内容哈希与规格不一致。',
      details: { expected: spec.testSet.contentHash, actual: testSetVersion.contentHash },
    });
  }
  let cases = testSetVersion.cases;
  if (spec.testSet.sampleSize && spec.testSet.sampleSize < cases.length) {
    const seed = spec.testSet.samplingSeed ?? 0;
    cases = [...cases]
      .map((item) => ({ item, rank: hashJson({ seed, caseVersionId: item.caseVersionId }) }))
      .sort((a, b) => (a.rank < b.rank ? -1 : 1))
      .slice(0, spec.testSet.sampleSize)
      .map((entry) => entry.item);
  }

  const models = spec.models.map((model) => {
    const version = getModelConfigVersion(ctx, model.modelConfigVersionId);
    if (version.contentHash !== model.contentHash) {
      throw createError('VALIDATION_SCHEMA_INVALID', {
        message: `模型 ${version.name} 的配置哈希与规格不一致。`,
        details: { expected: model.contentHash, actual: version.contentHash },
      });
    }
    const fallbacks = (model.fallbackModelConfigVersionIds ?? []).map((id) => getModelConfigVersion(ctx, id));
    return { ...version, modelProfileId: version.profileId, fallbacks };
  });

  const evaluationVersion = getEvaluationProfileVersion(ctx, spec.evaluation.profileVersionId);
  if (evaluationVersion.contentHash !== spec.evaluation.contentHash) {
    throw createError('VALIDATION_SCHEMA_INVALID', {
      message: '评分方案内容哈希与规格不一致。',
      details: { expected: spec.evaluation.contentHash, actual: evaluationVersion.contentHash },
    });
  }

  let dialogue = null;
  if (spec.execution?.dialogue) {
    const raw = spec.execution.dialogue;
    const generatorModel = getModelConfigVersion(ctx, raw.generatorModelConfigVersionId);
    let generatorPrompt = null;
    if (raw.generatorPromptVersionId) {
      const version = getPromptVersion(ctx, raw.generatorPromptVersionId);
      generatorPrompt = {
        promptVersionId: version.versionId,
        promptId: version.promptId,
        promptName: version.promptName,
        variantLabel: version.label,
        versionNumber: version.versionNumber,
        content: version.content,
        variables: version.variables,
        contentHash: version.contentHash,
      };
    }
    dialogue = {
      maxRounds: raw.maxRounds,
      generatorModel,
      generatorPrompt,
      initialInputPolicy: raw.initialInputPolicy ?? 'case_first',
      maxOutputTokensPerTurn: raw.maxOutputTokensPerTurn ?? null,
      termination: raw.termination?.length ? raw.termination : [{ type: 'literal', value: '<END>' }],
    };
  }

  // 变量可解析性
  const missingSamples = [];
  for (const variant of variants) {
    for (const testCase of cases) {
      const input = typeof testCase.input === 'object' && testCase.input !== null ? testCase.input : {};
      const missing = variant.variables.filter((name) => input[name] === undefined || input[name] === null);
      if (missing.length) missingSamples.push({ variant: variant.label, caseVersionId: testCase.caseVersionId, missing });
    }
  }
  if (dialogue?.generatorPrompt?.variables?.length) {
    for (const testCase of cases) {
      const input = typeof testCase.input === 'object' && testCase.input !== null ? testCase.input : {};
      const missing = dialogue.generatorPrompt.variables.filter((name) => input[name] === undefined || input[name] === null);
      if (missing.length) missingSamples.push({ variant: 'generator', caseVersionId: testCase.caseVersionId, missing });
    }
  }
  if (missingSamples.length) {
    throw createError('VALIDATION_UNRESOLVED_VARIABLE', {
      message: '存在无法解析的提示词变量。',
      details: { sampleErrors: missingSamples.slice(0, 5), total: missingSamples.length },
    });
  }

  return { variants, cases, models, evaluation: evaluationVersion, testSetVersion, dialogue };
}

function validateDialogueShape(dialogue, need) {
  need(dialogue && typeof dialogue === 'object' && !Array.isArray(dialogue), 'execution.dialogue', '必须是对象');
  if (!dialogue || typeof dialogue !== 'object' || Array.isArray(dialogue)) return;
  need(
    Number.isInteger(dialogue.maxRounds) && dialogue.maxRounds >= 1 && dialogue.maxRounds <= 20,
    'execution.dialogue.maxRounds',
    '必须是 1—20 的整数',
  );
  need(
    typeof dialogue.generatorModelConfigVersionId === 'string' && ID_PATTERN.test(dialogue.generatorModelConfigVersionId),
    'execution.dialogue.generatorModelConfigVersionId',
    '格式非法',
  );
  if (dialogue.generatorPromptVersionId !== undefined) {
    need(
      typeof dialogue.generatorPromptVersionId === 'string' && ID_PATTERN.test(dialogue.generatorPromptVersionId),
      'execution.dialogue.generatorPromptVersionId',
      '格式非法',
    );
  }
  if (dialogue.initialInputPolicy !== undefined) {
    need(
      ['case_first', 'generator_first'].includes(dialogue.initialInputPolicy),
      'execution.dialogue.initialInputPolicy',
      '取值非法',
    );
  }
  if (dialogue.maxOutputTokensPerTurn !== undefined) {
    need(
      Number.isInteger(dialogue.maxOutputTokensPerTurn) &&
        dialogue.maxOutputTokensPerTurn >= 1 &&
        dialogue.maxOutputTokensPerTurn <= 32768,
      'execution.dialogue.maxOutputTokensPerTurn',
      '必须是 1—32768 的整数',
    );
  }
  if (dialogue.termination !== undefined) {
    need(Array.isArray(dialogue.termination) && dialogue.termination.length <= 10, 'execution.dialogue.termination', '最多 10 条');
    (Array.isArray(dialogue.termination) ? dialogue.termination : []).forEach((item, index) => {
      const path = `execution.dialogue.termination[${index}]`;
      need(item && typeof item === 'object' && !Array.isArray(item), path, '必须是对象');
      if (!item || typeof item !== 'object') return;
      need(['literal', 'regex', 'json_condition'].includes(item.type), `${path}.type`, '取值非法');
      need(typeof item.value === 'string' && item.value.length > 0, `${path}.value`, '不能为空');
      if (typeof item.value !== 'string') return;
      if (item.type === 'regex') {
        try {
          new RegExp(item.value);
        } catch (error) {
          need(false, `${path}.value`, `正则非法: ${error.message}`);
        }
      }
      if (item.type === 'json_condition') {
        try {
          const parsed = JSON.parse(item.value);
          need(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${path}.value`, '必须是 JSON 对象');
        } catch {
          need(false, `${path}.value`, '必须是合法 JSON');
        }
      }
    });
  }
}

export function buildSnapshot(ctx, spec, resolved) {
  const snapshot = {
    schema: 'promptlens.experiment-snapshot/v1',
    createdAt: nowIso(),
    clientVersion: SERVER_VERSION,
    projectId: spec.projectId,
    spec,
    variants: resolved.variants.map((variant) => ({
      label: variant.label,
      promptVersionId: variant.promptVersionId,
      promptName: variant.promptName,
      variantLabel: variant.variantLabel,
      versionNumber: variant.versionNumber,
      content: variant.content,
      variables: variant.variables,
      contentHash: variant.contentHash,
    })),
    testSet: {
      testSetVersionId: resolved.testSetVersion.testSetVersionId ?? spec.testSet.testSetVersionId,
      name: resolved.testSetVersion.name,
      contentHash: resolved.testSetVersion.contentHash,
      requestedSampleSize: spec.testSet.sampleSize ?? null,
      samplingSeed: spec.testSet.samplingSeed ?? null,
      cases: resolved.cases,
    },
    models: resolved.models.map((model) => ({
      modelConfigVersionId: model.modelConfigVersionId,
      modelProfileId: model.modelProfileId,
      name: model.name,
      providerType: model.providerType,
      modelId: model.modelId,
      baseUrl: model.baseUrl,
      credentialRef: model.credentialRef,
      params: model.params,
      pricing: model.pricing,
      contentHash: model.contentHash,
      ...modelAdapterInfo(model),
      fallbackModelConfigVersionIds: (model.fallbacks ?? []).map((fallback) => fallback.modelConfigVersionId),
      fallbackModels: (model.fallbacks ?? []).map((fallback) => ({
        modelConfigVersionId: fallback.modelConfigVersionId,
        modelProfileId: fallback.profileId,
        name: fallback.name,
        providerType: fallback.providerType,
        modelId: fallback.modelId,
        baseUrl: fallback.baseUrl,
        credentialRef: fallback.credentialRef,
        params: fallback.params,
        pricing: fallback.pricing,
        contentHash: fallback.contentHash,
        ...modelAdapterInfo(fallback),
      })),
    })),
    dialogue: resolved.dialogue
      ? {
          maxRounds: resolved.dialogue.maxRounds,
          initialInputPolicy: resolved.dialogue.initialInputPolicy,
          maxOutputTokensPerTurn: resolved.dialogue.maxOutputTokensPerTurn,
          termination: resolved.dialogue.termination,
          generatorModel: {
            modelConfigVersionId: resolved.dialogue.generatorModel.modelConfigVersionId,
            modelProfileId: resolved.dialogue.generatorModel.profileId,
            name: resolved.dialogue.generatorModel.name,
            providerType: resolved.dialogue.generatorModel.providerType,
            modelId: resolved.dialogue.generatorModel.modelId,
            baseUrl: resolved.dialogue.generatorModel.baseUrl,
            credentialRef: resolved.dialogue.generatorModel.credentialRef,
            params: resolved.dialogue.generatorModel.params,
            pricing: resolved.dialogue.generatorModel.pricing,
            contentHash: resolved.dialogue.generatorModel.contentHash,
            ...modelAdapterInfo(resolved.dialogue.generatorModel),
          },
          generatorPrompt: resolved.dialogue.generatorPrompt,
        }
      : null,
    evaluation: {
      profileVersionId: resolved.evaluation.profileVersionId,
      name: resolved.evaluation.name,
      contentHash: resolved.evaluation.contentHash,
      config: resolved.evaluation.config,
    },
    execution: {
      order: spec.execution?.order ?? 'sequential',
      seed: spec.execution?.seed ?? 0,
      maxAttempts: spec.execution?.maxAttempts ?? 3,
      backoffBaseMs: spec.execution?.backoffBaseMs ?? 500,
      maxBackoffMs: spec.execution?.maxBackoffMs ?? 8000,
      maxConcurrency: spec.execution?.maxConcurrency ?? 4,
    },
    repetitions: spec.repetitions,
    budget: spec.budget,
  };
  return snapshot;
}

export function hashSnapshot(snapshot) {
  const { createdAt, ...rest } = snapshot;
  return hashJson(rest);
}

export function trialCount(snapshot) {
  return snapshot.variants.length * snapshot.testSet.cases.length * snapshot.models.length * snapshot.repetitions;
}

export function preflight(ctx, spec) {
  validateSpecShape(spec, { projectId: ctx.projectId });
  const resolved = resolveReferences(ctx, spec);
  const evaluationConfig = validateEvaluationConfig(resolved.evaluation.config);
  const evaluationWeights = normalizedWeights(evaluationConfig.dimensions);
  const snapshot = buildSnapshot(ctx, spec, resolved);
  snapshot.hash = hashSnapshot(snapshot);
  const count = trialCount(snapshot);
  const dialogueCallsPerTrial = snapshot.dialogue
    ? snapshot.dialogue.maxRounds + (snapshot.dialogue.initialInputPolicy === 'case_first' ? snapshot.dialogue.maxRounds - 1 : snapshot.dialogue.maxRounds)
    : 0;
  const worstCaseRequests = snapshot.dialogue ? count * dialogueCallsPerTrial : count;
  const warnings = [];
  const risks = [];

  if (Math.abs(evaluationWeights.total - 1) > 1e-9) {
    const detail = evaluationConfig.dimensions
      .map((dimension) => `${dimension.name} ${(evaluationWeights.byDimension[dimension.id] * 100).toFixed(1)}%`)
      .join(' / ');
    warnings.push({
      code: 'WEIGHTS_NORMALIZED',
      message: `评分权重总和为 ${evaluationWeights.total}，已按 ${detail} 归一化后比较。`,
    });
  }

  if (resolved.cases.length < 10) {
    warnings.push({ code: 'SMALL_SAMPLE', message: `测试集仅 ${resolved.cases.length} 条用例，结论不具备统计代表性。` });
  }
  if ((spec.repetitions ?? 1) < 2) {
    warnings.push({ code: 'NO_REPETITION', message: '每个组合仅运行 1 次，无法观察模型随机性。' });
  }
  const fallbackModels = resolved.models.filter((model) => (model.fallbacks ?? []).length > 0);
  if (fallbackModels.length) {
    warnings.push({
      code: 'FALLBACK_CONFIGURED',
      message: `模型 ${fallbackModels.map((model) => model.name).join('、')} 配置了回退，跨模型结果将标记为不可直接比较。`,
    });
    risks.push('存在故障转移配置；fallback 结果会记录实际模型并排除出对照均值。');
  }
  const allModels = [...resolved.models, ...(resolved.dialogue ? [resolved.dialogue.generatorModel] : [])];
  if (spec.budget.maxAmount && allModels.some((model) => !model.pricing)) {
    throw createError('BUDGET_PRICE_UNKNOWN', {
      message: '设置了金额上限，但存在未知价格的模型。',
      remediation: '为全部模型补充价格表，或改用 Token/请求数上限。',
      details: { models: allModels.filter((model) => !model.pricing).map((model) => model.name) },
    });
  }
  if (!spec.budget.maxRequests && !spec.budget.maxTotalTokens && !spec.budget.maxDurationSeconds) {
    warnings.push({ code: 'BUDGET_AMOUNT_ONLY', message: '仅设置金额上限；执行侧仍按请求计数，建议同时设置请求数上限。' });
  }
  if (allModels.every((model) => !model.pricing)) {
    warnings.push({ code: 'PRICE_UNKNOWN', message: '模型价格未知，成本将以“未知”呈现，不按 0 计算。' });
  }
  const unknownJudge = spec.evaluation.judgeModelConfigVersionId ? getModelConfigVersion(ctx, spec.evaluation.judgeModelConfigVersionId) : null;
  if (unknownJudge && !resolved.evaluation.config.judge?.enabled) {
    warnings.push({ code: 'JUDGE_NOT_ENABLED', message: '规格指定了 Judge 模型，但评分方案未启用 judge，已忽略。' });
  }
  if (snapshot.dialogue && spec.budget.maxRequests && worstCaseRequests > spec.budget.maxRequests) {
    warnings.push({
      code: 'DIALOGUE_BUDGET_TIGHT',
      message: `对话最坏需要 ${worstCaseRequests} 次模型调用，超过 maxRequests=${spec.budget.maxRequests}；运行将按预算提前停止。`,
    });
    risks.push('对话模式按轮次逐次调用模型，maxRequests 需覆盖最坏调用上界。');
  }

  const estimate = estimateCost(snapshot, worstCaseRequests);
  return {
    snapshot,
    snapshotHash: snapshot.hash,
    trialCount: count,
    resolved,
    warnings,
    risks,
    estimate,
    plan: {
      variants: snapshot.variants.map((variant) => variant.label),
      models: snapshot.models.map((model) => model.name),
      cases: snapshot.testSet.cases.length,
      repetitions: snapshot.repetitions,
      trialCount: count,
      maxAttempts: snapshot.execution.maxAttempts,
      maxConcurrency: snapshot.execution.maxConcurrency,
      budget: snapshot.budget,
      evaluation: {
        profileVersionId: resolved.evaluation.profileVersionId,
        versionNumber: resolved.evaluation.versionNumber,
        name: resolved.evaluation.name,
        scale: evaluationConfig.scale ?? null,
        weightTotal: evaluationWeights.total,
        weights: evaluationConfig.dimensions.map((dimension) => ({
          id: dimension.id,
          name: dimension.name,
          weight: dimension.weight,
          normalizedWeight: evaluationWeights.byDimension[dimension.id],
          gating: Boolean(dimension.gating),
          gate: dimension.gate ?? null,
        })),
      },
      ...(snapshot.dialogue
        ? {
            worstCaseRequests,
            dialogue: {
              maxRounds: snapshot.dialogue.maxRounds,
              generatorModel: snapshot.dialogue.generatorModel.name,
              initialInputPolicy: snapshot.dialogue.initialInputPolicy,
              maxOutputTokensPerTurn: snapshot.dialogue.maxOutputTokensPerTurn,
              termination: snapshot.dialogue.termination,
              callsPerTrial: dialogueCallsPerTrial,
            },
          }
        : {}),
    },
  };
}

function estimateCost(snapshot, count) {
  const allPricing = [
    ...snapshot.models.map((model) => model.pricing),
    ...(snapshot.dialogue ? [snapshot.dialogue.generatorModel.pricing] : []),
  ];
  const priced = allPricing.every(Boolean);
  if (!priced) return { amount: null, currency: null, completeness: 'unknown', plannedRequests: count };
  const amount = snapshot.models.reduce((total, model) => {
    const pricing = model.pricing;
    if (pricing.unit === 'per_request' && pricing.perRequest) {
      return total + Number(pricing.perRequest) * count / snapshot.models.length;
    }
    return total;
  }, 0);
  const tokenModels = allPricing.some((pricing) => pricing.unit !== 'per_request');
  return {
    amount: tokenModels ? null : String(amount),
    currency: snapshot.models[0]?.pricing?.currency ?? null,
    completeness: tokenModels ? 'partial' : 'estimated',
    plannedRequests: count,
    note: tokenModels ? 'Token 计价模型需执行后才能确定成本。' : null,
  };
}

export function persistSnapshot(ctx, snapshot) {
  const payload = `${JSON.stringify(snapshot, null, 2)}\n`;
  const object = putObject(ctx.root, payload);
  const snapshotId = ulid();
  ctx.db
    .prepare('INSERT INTO snapshots(id, project_id, content_hash, object_ref, spec_json, created_at) VALUES(?,?,?,?,?,?)')
    .run(snapshotId, snapshot.projectId, snapshot.hash, object.ref, canonicalJson(snapshot.spec), nowIso());
  return { snapshotId, objectRef: object.ref, snapshotHash: snapshot.hash };
}

export function loadSnapshot(ctx, snapshotId) {
  const row = ctx.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId);
  if (!row) throw createError('NOT_FOUND_RUN', { message: `快照不存在: ${snapshotId}` });
  const object = getObject(ctx.root, row.object_ref);
  const snapshot = JSON.parse(object.text);
  snapshot.id = row.id;
  snapshot.hash = row.content_hash;
  return snapshot;
}
