import { createError } from './errors.js';
import { hashJson } from './hash.js';
import { ulid } from './ids.js';
import { nowIso } from './time.js';
import { transaction } from './db.js';
import { mockGenerate } from '../providers/mock.js';
import { openAiCompatibleGenerate, openAiCompatibleListModels } from '../providers/openai.js';
import { recordAudit } from './audit.js';

const PROVIDER_TYPES = new Set(['mock', 'openai_compatible']);
const PRICING_UNITS = new Set(['per_million_tokens', 'per_token', 'per_request']);

export const ADAPTER_VERSIONS = Object.freeze({
  mock: 'mock/1',
  openai_compatible: 'openai-compatible/1',
});

export function validateBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw createError('VALIDATION_INVALID_REQUEST', { message: 'openai_compatible 模型需要 baseUrl。' });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw createError('VALIDATION_INVALID_REQUEST', { message: 'baseUrl 必须是合法 URL。', details: { baseUrl: raw } });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: 'baseUrl 仅支持 http 或 https。', details: { baseUrl: raw } });
  }
  if (url.username || url.password) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: 'baseUrl 不得包含用户名或密码，请使用 credentialRef。', details: { baseUrl: raw } });
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw createError('VALIDATION_INVALID_REQUEST', {
      message: '远程 HTTP 端点默认阻断；请使用 HTTPS，或仅对本地回环地址使用 HTTP。',
      details: { baseUrl: raw, host: url.hostname },
    });
  }
  return `${url.toString().replace(/\/+$/, '')}`;
}

export function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\./.test(host);
}

export function modelAdapterInfo(model) {
  const providerType = model?.providerType ?? 'mock';
  return {
    adapterVersion: ADAPTER_VERSIONS[providerType] ?? 'unknown/0',
    capabilities: {
      chat: true,
      streaming: false,
      modelList: providerType === 'openai_compatible',
      maxContextTokens: positiveInteger(model?.params?.contextLength ?? model?.params?.maxContextTokens),
    },
  };
}

export function validateModelInput(input) {
  if (!String(input.name ?? '').trim()) throw createError('VALIDATION_INVALID_REQUEST', { message: '模型配置需要名称。' });
  if (!PROVIDER_TYPES.has(input.providerType)) {
    throw createError('VALIDATION_INVALID_REQUEST', {
      message: `providerType 必须是 ${[...PROVIDER_TYPES].join(' 或 ')}。`,
      details: { providerType: input.providerType },
    });
  }
  if (!String(input.modelId ?? '').trim()) throw createError('VALIDATION_INVALID_REQUEST', { message: '模型配置需要 modelId。' });
  if (input.providerType === 'openai_compatible') validateBaseUrl(input.baseUrl);
  if (input.credentialRef != null && !/^(env:[A-Za-z_][A-Za-z0-9_]*|keychain:[^:\s]+(?::[^:\s]+)?)$/.test(input.credentialRef)) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: 'credentialRef 必须形如 env:OPENAI_API_KEY 或 keychain:service[:account]。' });
  }
  if (input.params != null && (typeof input.params !== 'object' || Array.isArray(input.params))) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: 'params 必须是对象。' });
  }
  if (input.pricing != null) validatePricing(input.pricing);
}

export function validatePricing(pricing) {
  if (typeof pricing !== 'object' || Array.isArray(pricing)) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: 'pricing 必须是对象。' });
  }
  if (!/^[A-Z]{3}$/.test(String(pricing.currency ?? ''))) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: 'pricing.currency 必须是三位大写币种代码。' });
  }
  if (!PRICING_UNITS.has(pricing.unit)) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: `pricing.unit 必须是 ${[...PRICING_UNITS].join(' / ')}。` });
  }
  const decimal = /^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/;
  for (const field of ['input', 'output', 'cachedInput', 'reasoning', 'perRequest']) {
    const value = pricing[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !decimal.test(value)) {
      throw createError('VALIDATION_INVALID_REQUEST', { message: `pricing.${field} 必须是十进制字符串。` });
    }
  }
  if (pricing.unit === 'per_request' && !pricing.perRequest) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: 'per_request 价格表必须提供 perRequest。' });
  }
  if (pricing.unit !== 'per_request' && (!pricing.input || !pricing.output)) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: 'Token 计价必须提供 input 与 output 单价。' });
  }
}

export function addModel(ctx, input) {
  validateModelInput(input);
  const clean = {
    name: String(input.name).trim(),
    providerType: input.providerType,
    modelId: String(input.modelId).trim(),
    baseUrl: input.providerType === 'openai_compatible' ? validateBaseUrl(input.baseUrl) : null,
    credentialRef: input.credentialRef ?? null,
    params: input.params ?? {},
    pricing: input.pricing ?? null,
  };
  const contentHash = hashJson({
    providerType: clean.providerType,
    modelId: clean.modelId,
    baseUrl: clean.baseUrl,
    credentialRef: clean.credentialRef,
    params: clean.params,
    pricing: clean.pricing,
  });

  return transaction(ctx.db, () => {
    let profile = ctx.db.prepare('SELECT * FROM model_profiles WHERE name = ?').get(clean.name);
    if (profile && profile.provider_type !== clean.providerType) {
      throw createError('STATE_INVALID_TRANSITION', {
        message: `模型配置 "${clean.name}" 已存在且 providerType 不同。`,
        details: { existing: profile.provider_type, requested: clean.providerType },
      });
    }
    if (!profile) {
      const profileId = ulid();
      ctx.db
        .prepare('INSERT INTO model_profiles(id, name, provider_type, created_at) VALUES(?,?,?,?)')
        .run(profileId, clean.name, clean.providerType, nowIso());
      profile = { id: profileId, name: clean.name, provider_type: clean.providerType };
    }
    const latest = ctx.db
      .prepare('SELECT * FROM model_config_versions WHERE profile_id = ? ORDER BY version_number DESC LIMIT 1')
      .get(profile.id);
    if (latest && latest.content_hash === contentHash) {
      return { profileId: profile.id, name: profile.name, modelConfigVersionId: latest.id, versionNumber: latest.version_number, contentHash: latest.content_hash, created: false };
    }
    const versionId = ulid();
    const versionNumber = (latest?.version_number ?? 0) + 1;
    ctx.db
      .prepare(
        `INSERT INTO model_config_versions(id, profile_id, version_number, model_id, base_url, credential_ref, params_json, pricing_json, content_hash, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        versionId,
        profile.id,
        versionNumber,
        clean.modelId,
        clean.baseUrl,
        clean.credentialRef,
        JSON.stringify(clean.params),
        clean.pricing ? JSON.stringify(clean.pricing) : null,
        contentHash,
        nowIso(),
      );
    recordAudit(ctx, 'model.added', {
      profileId: profile.id,
      modelConfigVersionId: versionId,
      versionNumber,
      providerType: clean.providerType,
      modelId: clean.modelId,
    });
    return { profileId: profile.id, name: profile.name, modelConfigVersionId: versionId, versionNumber, contentHash, created: true };
  });
}

export function getModelConfigVersion(ctx, versionId) {
  const row = ctx.db
    .prepare(
      `SELECT mcv.*, mp.name AS profile_name, mp.provider_type
       FROM model_config_versions mcv JOIN model_profiles mp ON mp.id = mcv.profile_id
       WHERE mcv.id = ?`,
    )
    .get(versionId);
  if (!row) throw createError('NOT_FOUND_MODEL', { message: `模型配置版本不存在: ${versionId}` });
  return mapModelRow(row);
}

export function findModelByName(ctx, name) {
  const profile = ctx.db.prepare('SELECT * FROM model_profiles WHERE name = ?').get(String(name).trim());
  if (!profile) throw createError('NOT_FOUND_MODEL', { message: `模型配置不存在: ${name}` });
  const latest = ctx.db
    .prepare('SELECT * FROM model_config_versions WHERE profile_id = ? ORDER BY version_number DESC LIMIT 1')
    .get(profile.id);
  if (!latest) throw createError('NOT_FOUND_MODEL', { message: `模型配置 "${name}" 没有可用版本。` });
  return getModelConfigVersion(ctx, latest.id);
}

function mapModelRow(row) {
  const model = {
    modelConfigVersionId: row.id,
    profileId: row.profile_id,
    name: row.profile_name,
    providerType: row.provider_type,
    modelId: row.model_id,
    baseUrl: row.base_url,
    credentialRef: row.credential_ref,
    params: JSON.parse(row.params_json),
    pricing: row.pricing_json ? JSON.parse(row.pricing_json) : null,
    versionNumber: row.version_number,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
  return { ...model, ...modelAdapterInfo(model) };
}

export function listModels(ctx) {
  return ctx.db.prepare('SELECT * FROM model_profiles ORDER BY created_at, id').all().map((profile) => {
    const versions = ctx.db
      .prepare('SELECT * FROM model_config_versions WHERE profile_id = ? ORDER BY version_number DESC')
      .all(profile.id)
      .map(mapModelRow);
    return {
      profileId: profile.id,
      name: profile.name,
      providerType: profile.provider_type,
      latest: versions[0] ?? null,
      versions,
    };
  });
}

export async function testConnection(ctx, modelRef, options = {}) {
  const resolved = resolveModelRef(ctx, modelRef);
  const started = Date.now();
  const result = await callModel({
    modelConfig: resolved,
    messages: [{ role: 'user', content: '请回复 "pong"。' }],
    caseMeta: null,
    variantLabel: 'A',
    attemptNumber: 1,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    promptText: 'ping',
    caseInput: 'ping',
  });
  return {
    modelConfigVersionId: resolved.modelConfigVersionId,
    modelId: resolved.modelId,
    ok: true,
    latencyMs: Date.now() - started,
    sample: result.content.slice(0, 200),
    finishReason: result.finishReason,
    usage: result.usage,
    ...modelAdapterInfo(resolved),
  };
}

export async function probeModels(ctx, ref, options = {}) {
  const resolved = resolveModelRef(ctx, ref);
  const started = Date.now();
  const models =
    resolved.providerType === 'mock'
      ? [{ id: resolved.modelId, ownedBy: 'mock' }]
      : await openAiCompatibleListModels({ modelConfig: resolved, signal: options.signal, fetchImpl: options.fetchImpl });
  return {
    modelConfigVersionId: resolved.modelConfigVersionId,
    modelId: resolved.modelId,
    latencyMs: Date.now() - started,
    models,
    ...modelAdapterInfo(resolved),
  };
}

function resolveModelRef(ctx, ref) {
  try {
    return findModelByName(ctx, ref);
  } catch (error) {
    if (error.code !== 'NOT_FOUND_MODEL') throw error;
    return getModelConfigVersion(ctx, ref);
  }
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export async function callModel({ modelConfig, messages, caseMeta, variantLabel, attemptNumber, signal, fetchImpl, promptText, caseInput, turnIndex = 0 }) {
  if (modelConfig.providerType === 'mock') {
    return mockGenerate({ modelConfig, caseMeta, variantLabel, attemptNumber, signal, promptText, caseInput, turnIndex });
  }
  if (modelConfig.providerType === 'openai_compatible') {
    return openAiCompatibleGenerate({ modelConfig, messages, signal, fetchImpl });
  }
  throw createError('VALIDATION_INVALID_REQUEST', { message: `未知 providerType: ${modelConfig.providerType}` });
}

/** 按价格表计算一次调用的估算成本；缺价返回 unknown，绝不按 0 处理。 */
export function computeUsageCost(usage, pricing) {
  if (!pricing) return { amount: null, currency: null, billingState: 'unknown' };
  const unit = pricing.unit;
  if (unit === 'per_request') {
    if (pricing.perRequest == null) return { amount: null, currency: pricing.currency, billingState: 'unknown' };
    return { amount: formatAmount(Number(pricing.perRequest)), currency: pricing.currency, billingState: 'known' };
  }
  const divisor = unit === 'per_million_tokens' ? 1_000_000 : 1;
  const price = (value) => (value == null ? null : Number(value));
  const inputPrice = price(pricing.input);
  const outputPrice = price(pricing.output);
  const cachedPrice = price(pricing.cachedInput);
  if (inputPrice === null || outputPrice === null) return { amount: null, currency: pricing.currency, billingState: 'unknown' };
  if (usage.inputTokens == null || usage.outputTokens == null) {
    return { amount: null, currency: pricing.currency, billingState: 'unknown' };
  }
  const cached = usage.cachedInputTokens ?? 0;
  const billableInput = Math.max(0, usage.inputTokens - cached);
  let total = (billableInput * inputPrice + usage.outputTokens * outputPrice) / divisor;
  if (cached && cachedPrice !== null) total += (cached * cachedPrice) / divisor;
  return { amount: formatAmount(total), currency: pricing.currency, billingState: 'known' };
}

export function formatAmount(value) {
  if (!Number.isFinite(value)) return null;
  return value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

export function addAmounts(left, right) {
  if (left == null || right == null) return null;
  return formatAmount(Number(left) + Number(right));
}
