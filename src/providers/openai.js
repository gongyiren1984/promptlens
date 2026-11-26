import { execFileSync } from 'node:child_process';
import { createError } from '../core/errors.js';

export function resolveCredential(ref) {
  if (!ref) return null;
  if (ref.startsWith('keychain:')) {
    const [service, account] = ref.slice('keychain:'.length).split(':');
    if (!service) {
      throw createError('VALIDATION_INVALID_REQUEST', { message: 'keychain 引用需要服务名。', details: { credentialRef: ref } });
    }
    if (process.platform !== 'darwin') {
      throw createError('AUTH_CREDENTIAL_UNAVAILABLE', {
        message: '当前平台未接入系统密钥链，请改用 env: 引用。',
        details: { credentialRef: ref, platform: process.platform },
      });
    }
    try {
      const args = ['find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w'];
      const value = execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (!value) throw new Error('empty');
      return value;
    } catch {
      throw createError('AUTH_CREDENTIAL_UNAVAILABLE', {
        message: '系统密钥链条目中未找到凭据。',
        details: { credentialRef: ref },
      });
    }
  }
  if (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
    throw createError('VALIDATION_INVALID_REQUEST', {
      message: '凭据引用必须是 env:VARIABLE_NAME 或 keychain:service[:account] 形式，禁止持久化明文密钥。',
      details: { credentialRef: ref },
    });
  }
  const name = ref.slice(4);
  const value = process.env[name];
  if (!value) {
    throw createError('AUTH_CREDENTIAL_UNAVAILABLE', {
      message: `环境变量 ${name} 未设置，无法解析凭据引用。`,
      details: { credentialRef: ref },
    });
  }
  return value;
}

/** OpenAI 兼容 Chat Completions 适配器。 */
export async function openAiCompatibleGenerate({ modelConfig, messages, signal, fetchImpl = fetch }) {
  const started = Date.now();
  const apiKey = resolveCredential(modelConfig.credentialRef);
  const baseUrl = String(modelConfig.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw createError('VALIDATION_INVALID_REQUEST', { message: 'openai_compatible 模型缺少 baseUrl。' });

  const params = modelConfig.params ?? {};
  const body = {
    model: modelConfig.modelId,
    messages,
    temperature: params.temperature ?? 0.2,
  };
  if (params.maxTokens) body.max_tokens = params.maxTokens;
  if (params.topP !== undefined) body.top_p = params.topP;
  if (params.seed !== undefined) body.seed = params.seed;

  const timeoutMs = params.timeoutMs ?? 60_000;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error('timeout')), timeoutMs);
  const combined = combineSignals(signal, timeoutController.signal);

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: combined.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (signal?.aborted) throw abortError();
    const code = error?.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE';
    throw createError(code, { message: `模型服务请求失败: ${error?.message ?? error}` });
  }
  clearTimeout(timer);

  if (!response.ok) {
    const text = await safeText(response);
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    throw mapHttpError(response.status, text, retryAfterMs);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw createError('PROVIDER_INVALID_REQUEST', { message: `模型响应不是合法 JSON: ${error.message}` });
  }

  const choice = payload.choices?.[0];
  const content = choice?.message?.content ?? '';
  const usage = payload.usage ?? {};
  return {
    content: typeof content === 'string' ? content : JSON.stringify(content),
    finishReason: choice?.finish_reason ?? 'stop',
    usage: {
      inputTokens: usage.prompt_tokens ?? null,
      outputTokens: usage.completion_tokens ?? null,
      cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
      raw: usage,
      normalizerVersion: 'openai-chat/1',
    },
    modelId: payload.model ?? modelConfig.modelId,
    latencyMs: Date.now() - started,
    raw: payload,
  };
}

/** 拉取 OpenAI 兼容服务的模型列表，用于能力探测。 */
export async function openAiCompatibleListModels({ modelConfig, signal, fetchImpl = fetch }) {
  const apiKey = resolveCredential(modelConfig.credentialRef);
  const baseUrl = String(modelConfig.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw createError('VALIDATION_INVALID_REQUEST', { message: 'openai_compatible 模型缺少 baseUrl。' });
  const timeoutMs = modelConfig.params?.timeoutMs ?? 60_000;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error('timeout')), timeoutMs);
  const combined = combineSignals(signal, timeoutController.signal);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/models`, {
      method: 'GET',
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: combined.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (signal?.aborted) throw abortError();
    const code = error?.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE';
    throw createError(code, { message: `模型列表请求失败: ${error?.message ?? error}` });
  }
  clearTimeout(timer);
  if (!response.ok) {
    const text = await safeText(response);
    throw mapHttpError(response.status, text, parseRetryAfter(response.headers.get('retry-after')));
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw createError('PROVIDER_INVALID_REQUEST', { message: '模型列表响应不是合法 JSON。' });
  }
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : null;
  if (!data) throw createError('PROVIDER_INVALID_REQUEST', { message: '模型列表响应缺少 data 数组。' });
  return data
    .filter((item) => item && typeof item.id === 'string' && item.id)
    .map((item) => ({ id: item.id, ownedBy: item.owned_by ?? null, created: item.created ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function mapHttpError(status, text, retryAfterMs) {
  const details = { status, body: text.slice(0, 1000), retryAfterMs };
  if (status === 401 || status === 403) return createError('PROVIDER_AUTH_FAILED', { message: '模型服务鉴权失败。', details });
  if (status === 404) return createError('PROVIDER_MODEL_NOT_FOUND', { message: '模型 ID 不存在或接口路径错误。', details });
  if (status === 429) return createError('PROVIDER_RATE_LIMITED', { message: '模型服务限流。', details });
  if (status === 400 && /context|maximum.*token|too long/i.test(text)) {
    return createError('PROVIDER_CONTEXT_TOO_LONG', { message: '上下文超过模型窗口。', details });
  }
  if (status === 400 || status === 422) return createError('PROVIDER_INVALID_REQUEST', { message: '模型服务拒绝了请求格式。', details });
  if (status >= 500) return createError('PROVIDER_UNAVAILABLE', { message: '模型服务暂时不可用。', details });
  return createError('PROVIDER_INVALID_REQUEST', { message: `模型服务返回 HTTP ${status}。`, details });
}

function safeText(response) {
  return response.text().catch(() => '');
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function combineSignals(...signals) {
  const controller = new AbortController();
  const onAbort = (event) => controller.abort(event?.target?.reason ?? new Error('aborted'));
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return controller;
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}
