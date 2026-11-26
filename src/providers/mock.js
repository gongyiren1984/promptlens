import { createError } from '../core/errors.js';
import { sleep } from '../core/time.js';
import { sha256Hex } from '../core/hash.js';

/**
 * 确定性 mock 提供方：用于演示与测试，不联网。
 * 剧本来自用例 meta.mock[variantLabel]（或 meta.mock.default）：
 *   "文本" 或 { content, finishReason, errorCode, latencyMs, usage }
 */
export async function mockGenerate({ modelConfig, caseMeta, variantLabel, attemptNumber, signal, promptText, caseInput, turnIndex = 0 }) {
  const started = Date.now();
  const params = modelConfig.params ?? {};
  const script = params.mockAlwaysSucceed ? {} : resolveScript(caseMeta, variantLabel);
  const latencyMs = Number(script.latencyMs ?? 0);
  if (latencyMs > 0) await sleep(latencyMs, signal);

  if (params.mockFailureCode) {
    throw createError(params.mockFailureCode, {
      message: `mock 模型被配置为始终失败: ${params.mockFailureCode}`,
      details: { providerType: 'mock', modelId: modelConfig.modelId, attemptNumber },
    });
  }

  if (script.errorCode) {
    throw createError(script.errorCode, {
      message: script.errorMessage || `mock 触发 ${script.errorCode}`,
      details: { providerType: 'mock', modelId: modelConfig.modelId, attemptNumber },
    });
  }
  if (script.failCode && attemptNumber <= (script.failAttempts ?? 1)) {
    throw createError(script.failCode, {
      message: script.failMessage || `mock 模拟第 ${attemptNumber} 次调用失败`,
      details: { providerType: 'mock', modelId: modelConfig.modelId, attemptNumber, retryAfterMs: script.retryAfterMs ?? 0 },
    });
  }

  const seed = sha256Hex(`${modelConfig.modelId}|${promptText}|${JSON.stringify(caseInput)}|${attemptNumber}`).slice(0, 12);
  const scriptedContent = Array.isArray(script.content)
    ? script.content[Math.min(Math.max(0, turnIndex), script.content.length - 1)]
    : script.content;
  const content =
    scriptedContent !== undefined
      ? String(scriptedContent)
      : params.mockAlwaysSucceed
        ? params.mockContent ?? `感谢您的耐心等待，已为您查询订单。mock-${seed}`
        : deterministicText(seed, caseInput);
  const finalContent =
    promptText === 'judge' && (params.mockJudgeScores || params.mockJudgeScoresSequence)
      ? judgeResponse(params, attemptNumber)
      : content;
  const inputTokens = script.usage?.inputTokens ?? Math.max(1, Math.ceil((String(promptText).length + JSON.stringify(caseInput).length) / 4));
  const outputTokens = script.usage?.outputTokens ?? Math.max(1, Math.ceil(finalContent.length / 4));

  return {
    content: finalContent,
    finishReason: script.finishReason ?? 'stop',
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      raw: { mock: true, seed },
      normalizerVersion: 'mock/1',
    },
    modelId: modelConfig.modelId,
    latencyMs: Date.now() - started,
    raw: { mock: true, seed },
  };
}

function judgeResponse(params, attemptNumber) {
  const sequence = params.mockJudgeScoresSequence;
  const scores = Array.isArray(sequence)
    ? sequence[Math.min(Math.max(0, attemptNumber - 1), sequence.length - 1)]
    : params.mockJudgeScores;
  return JSON.stringify({ scores: scores ?? {}, rationale: params.mockJudgeRationale ?? `mock judge #${attemptNumber}` });
}

function resolveScript(caseMeta, variantLabel) {
  const mock = caseMeta && typeof caseMeta === 'object' ? caseMeta.mock : null;
  if (!mock) return {};
  if (typeof mock === 'string') return { content: mock };
  const byVariant = variantLabel ? mock[variantLabel] : undefined;
  if (typeof byVariant === 'string') return { content: byVariant };
  if (byVariant && typeof byVariant === 'object') return byVariant;
  if (mock.default !== undefined) return typeof mock.default === 'string' ? { content: mock.default } : mock.default;
  return {};
}

function deterministicText(seed, caseInput) {
  const userText = typeof caseInput === 'string' ? caseInput : JSON.stringify(caseInput);
  return `mock-${seed}: ${userText.slice(0, 120)}`;
}
