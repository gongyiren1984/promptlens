import { createError } from '../core/errors.js';
import { callModel } from '../core/models.js';

export function buildJudgeMessages({ dimensions, content, caseInput, expected, instructions, scale = null }) {
  const rubric = dimensions
    .map((dimension) => `- ${dimension.id}（${dimension.name}）：${dimension.description ?? '按名称判断质量'}`)
    .join('\n');
  const scaleLine = describeScale(scale);
  const system =
    instructions ||
    `你是严格的提示词评审模型。只能依据给定用例、参考答案和候选输出评分，不得臆测。${scaleLine}只输出 JSON。`;
  const exampleScore = scale ? scale.min : 0.0;
  const user = `评分维度：
${rubric}

${scaleLine}

用例输入：
${stringify(caseInput)}

参考答案（可能为空）：
${stringify(expected)}

候选输出：
${content}

请只输出 JSON：{"scores":{"<维度id>":${exampleScore}},"rationale":"简要理由"}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function describeScale(scale) {
  if (!scale) return '评分刻度：0—1 的小数（1 为最好）。';
  const anchors = Object.entries(scale.anchors ?? {})
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([level, text]) => `${level}=${text}`)
    .join('；');
  return `评分刻度：${scale.min}—${scale.max} 的整数（${scale.min} 为最差，${scale.max} 为最好）。${anchors ? `锚点：${anchors}。` : ''}`;
}

export function parseJudgeResponse(text, scale = null) {
  const raw = String(text ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw createError('PROVIDER_INVALID_REQUEST', { message: '评审模型未返回 JSON。' });
  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw createError('PROVIDER_INVALID_REQUEST', { message: `评审模型 JSON 解析失败: ${error.message}` });
  }
  if (!parsed.scores || typeof parsed.scores !== 'object') {
    throw createError('PROVIDER_INVALID_REQUEST', { message: '评审模型返回缺少 scores。' });
  }
  const scores = {};
  for (const [key, value] of Object.entries(parsed.scores)) {
    const num = Number(value);
    if (!Number.isFinite(num)) continue;
    if (!scale) {
      scores[key] = Math.min(1, Math.max(0, num));
      continue;
    }
    const min = Number(scale.min);
    const max = Number(scale.max);
    const clamped = Math.min(max, Math.max(min, num));
    scores[key] = max === min ? 0 : (clamped - min) / (max - min);
  }
  return { scores, rationale: parsed.rationale ?? null };
}

export async function judgeTrial({ judgeModel, dimensions, content, caseInput, expected, instructions, repetitions, signal, fetchImpl, scale = null }) {
  const runs = [];
  const errors = [];
  for (let i = 0; i < repetitions; i++) {
    try {
      const result = await callModel({
        modelConfig: judgeModel,
        messages: buildJudgeMessages({ dimensions, content, caseInput, expected, instructions, scale }),
        caseMeta: null,
        variantLabel: null,
        attemptNumber: i + 1,
        signal,
        fetchImpl,
        promptText: 'judge',
        caseInput,
      });
      const parsed = parseJudgeResponse(result.content, scale);
      runs.push({
        content: result.content,
        scores: parsed.scores,
        rationale: parsed.rationale,
        usage: result.usage,
        modelId: result.modelId,
        finishReason: result.finishReason,
      });
    } catch (error) {
      errors.push({ message: error.message, code: error.code ?? 'PROVIDER_INVALID_REQUEST' });
    }
  }
  if (!runs.length) {
    return { scores: {}, runs, errors, consistency: null };
  }
  const scores = {};
  for (const dimension of dimensions) {
    const values = runs.map((run) => run.scores[dimension.id]).filter((value) => Number.isFinite(value));
    if (values.length) scores[dimension.id] = values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  let consistency = null;
  if (runs.length > 1) {
    const spreads = dimensions
      .map((dimension) => {
        const values = runs.map((run) => run.scores[dimension.id]).filter((value) => Number.isFinite(value));
        return values.length > 1 ? Math.max(...values) - Math.min(...values) : null;
      })
      .filter((value) => value !== null);
    if (spreads.length) consistency = 1 - spreads.reduce((sum, value) => sum + value, 0) / spreads.length;
  }
  return { scores, runs, errors, consistency };
}

function stringify(value) {
  if (value === null || value === undefined) return '（空）';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
