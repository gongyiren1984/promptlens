import { createError } from './errors.js';
import { callModel, computeUsageCost, findModelByName, getModelConfigVersion } from './models.js';
import { normalizeCaseRecord } from './cases.js';
import { hashJson } from './hash.js';
import { nowIso } from './time.js';
import { recordAudit } from './audit.js';

const MAX_COUNT = 50;

/**
 * 用已配置的模型生成候选测试用例。结果只作为候选，必须经导入预览与用户确认后才落库。
 * mock 模型不联网，按说明生成确定性样例，便于演示与测试完整链路。
 */
export async function generateCases(ctx, { modelConfigVersionId, modelRef = null, instruction, count = 10, signal = null, fetchImpl = null } = {}) {
  const modelConfig = resolveModel(ctx, modelConfigVersionId ?? modelRef);
  const desired = Number(count);
  if (!Number.isInteger(desired) || desired < 1 || desired > MAX_COUNT) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: `生成数量必须在 1—${MAX_COUNT} 之间。` });
  }
  const text = String(instruction ?? '').trim();
  if (!text) throw createError('VALIDATION_INVALID_REQUEST', { message: '请填写生成说明，例如业务场景与输入应覆盖的边界。' });

  const examples = ctx.db.prepare('SELECT input_json FROM cases ORDER BY created_at DESC LIMIT 5').all().map((row) => JSON.parse(row.input_json));
  const inputKey = guessInputKey(examples);
  const started = Date.now();

  let candidates;
  let usage = null;
  let modelResult = null;
  if (modelConfig.providerType === 'mock') {
    candidates = mockCandidates({ instruction: text, count: desired, inputKey });
  } else {
    const messages = buildGenerationMessages({ instruction: text, count: desired, examples });
    modelResult = await callModel({
      modelConfig,
      messages,
      caseMeta: null,
      variantLabel: null,
      attemptNumber: 1,
      signal,
      fetchImpl,
      promptText: messages.map((message) => message.content).join('\n'),
      caseInput: { instruction: text },
    });
    candidates = parseCandidates(modelResult.content);
  }

  const records = [];
  const errors = [];
  const seen = new Set();
  let duplicates = 0;
  candidates.slice(0, desired).forEach((candidate, index) => {
    const normalized = normalizeCaseRecord(candidate, index);
    if (normalized.error) {
      errors.push({ row: index + 1, message: normalized.error });
      return;
    }
    const key = hashJson({ input: normalized.case.input, expected: normalized.case.expected });
    if (seen.has(key)) {
      duplicates += 1;
      return;
    }
    seen.add(key);
    records.push({
      ...normalized.case,
      meta: {
        ...(normalized.case.meta ?? {}),
        generated: true,
        generator: {
          modelConfigVersionId: modelConfig.modelConfigVersionId,
          providerType: modelConfig.providerType,
          instruction: text.slice(0, 200),
        },
      },
    });
  });

  const cost = modelResult?.usage ? computeUsageCost(modelResult.usage, modelConfig.pricing) : { amount: null, currency: null, billingState: 'not_billed' };
  recordAudit(ctx, 'cases.generated_preview', {
    modelConfigVersionId: modelConfig.modelConfigVersionId,
    requested: desired,
    produced: records.length,
    invalid: errors.length,
    duplicates,
    cost: cost.amount,
    currency: cost.currency,
  });
  return {
    records,
    errors,
    duplicateCandidates: duplicates,
    generator: {
      modelConfigVersionId: modelConfig.modelConfigVersionId,
      name: modelConfig.name,
      providerType: modelConfig.providerType,
      modelId: modelConfig.modelId,
      instruction: text,
      requested: desired,
      produced: records.length,
      generatedAt: nowIso(),
      latencyMs: Date.now() - started,
    },
    usage: modelResult?.usage ?? null,
    cost,
    warnings:
      errors.length || duplicates
        ? [{ code: 'CASE_GENERATION_FILTERED', message: `已过滤 ${errors.length} 条无效与 ${duplicates} 条重复候选。` }]
        : [],
  };
}

export function buildGenerationMessages({ instruction, count, examples }) {
  return [
    {
      role: 'system',
      content:
        '你是严谨的测试用例设计助手。根据用户说明生成多样化、可验证、互不重复的测试输入，覆盖正常路径与边界。只输出 JSON 数组，不要输出解释。',
    },
    {
      role: 'user',
      content: `生成 ${count} 条测试用例。

业务说明：
${instruction}

已有用例示例（仅供风格参考，不要重复）：
${JSON.stringify(examples)}

输出格式：JSON 数组，每项为 {"input": 任意 JSON, "expected": 任意 JSON 或 null, "meta": 对象或 null}。input 字段结构应与示例保持一致。`,
    },
  ];
}

export function parseCandidates(text) {
  const raw = String(text ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start < 0 || end <= start) throw createError('PROVIDER_INVALID_REQUEST', { message: '生成模型未返回 JSON 数组。' });
  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw createError('PROVIDER_INVALID_REQUEST', { message: `生成结果 JSON 解析失败: ${error.message}` });
  }
  if (!Array.isArray(parsed)) throw createError('PROVIDER_INVALID_REQUEST', { message: '生成结果必须是数组。' });
  return parsed;
}

function resolveModel(ctx, ref) {
  if (!ref) throw createError('VALIDATION_INVALID_REQUEST', { message: '请选择用于生成用例的模型。' });
  try {
    return getModelConfigVersion(ctx, ref);
  } catch (error) {
    if (error.code !== 'NOT_FOUND_MODEL') throw error;
    return findModelByName(ctx, ref);
  }
}

function guessInputKey(examples) {
  for (const example of examples) {
    if (example && typeof example === 'object' && !Array.isArray(example)) {
      const keys = Object.keys(example);
      if (keys.length) return keys[0];
    }
  }
  return 'question';
}

function mockCandidates({ instruction, count, inputKey }) {
  const topics = ['订单状态', '退款进度', '修改地址', '发票开具', '物流异常', '优惠券使用', '会员权益', '投诉处理', '退换货', '加急配送'];
  return Array.from({ length: count }, (_, index) => ({
    input: { [inputKey]: `${topics[index % topics.length]}：${instruction.slice(0, 40)}（样例 ${index + 1}）` },
    expected: null,
    meta: { scenario: topics[index % topics.length], index: index + 1 },
  }));
}
