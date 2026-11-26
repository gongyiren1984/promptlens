import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, openProject } from '../src/core/project.js';
import { importPrompts } from '../src/core/assets.js';
import { importCases } from '../src/core/cases.js';
import { createEvaluationProfile } from '../src/eval/profile.js';
import { addModel, getModelConfigVersion } from '../src/core/models.js';

export function createTempProject(name = '测试项目') {
  const dir = mkdtempSync(join(tmpdir(), 'promptlens-'));
  const { manifest } = createProject({ path: dir, name });
  const ctx = openProject(dir);
  return {
    ctx,
    root: dir,
    manifest,
    cleanup() {
      try {
        ctx.close();
      } catch {
        /* 已关闭 */
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

export const DEFAULT_EVAL_CONFIG = {
  schema: 'promptlens.evaluation-profile/v1',
  dimensions: [
    { id: 'accuracy', name: '准确性', weight: 0.5, gating: false, rules: [{ type: 'contains', value: '订单' }] },
    { id: 'empathy', name: '共情', weight: 0.5, gating: false, rules: [{ type: 'contains', value: '感谢' }] },
  ],
};

export const PRICING = { currency: 'USD', unit: 'per_request', perRequest: '0.001' };

export function seedProject(ctx, options = {}) {
  const prompts = importPrompts(ctx, {
    prompt: { name: '客服回复' },
    variants: [
      { label: 'A', content: '直接回答用户问题。\n\n用户问题：{{question}}' },
      { label: 'B', content: '你是专业客服，请先感谢用户。\n\n用户问题：{{question}}' },
    ],
  }).variants;
  const records = options.cases ?? [
    { input: { question: '订单什么时候到？' }, meta: { mock: { A: '好的，订单已处理。', B: '感谢您的耐心等待，订单预计今天送达。' } } },
    { input: { question: '订单能改地址吗？' }, meta: { mock: { A: '好的，订单已处理。', B: '感谢您的耐心等待，订单地址可修改。' } } },
    { input: { question: '订单能退吗？' }, meta: { mock: { A: '好的，订单已处理。', B: '感谢您的耐心等待，订单可申请退货。' } } },
    { input: { question: '订单能加急吗？' }, meta: { mock: { A: '好的，订单已处理。', B: '感谢您的耐心等待，订单可尝试加急。' } } },
  ];
  const imported = importCases(ctx, { records, setName: options.setName ?? '基础集', source: 'test' });
  const evaluation = createEvaluationProfile(ctx, {
    name: options.evalName ?? '默认规则',
    config: options.evalConfig ?? DEFAULT_EVAL_CONFIG,
  });
  const model = addModel(ctx, {
    name: options.modelName ?? 'mock-primary',
    providerType: 'mock',
    modelId: 'mock-large',
    params: options.modelParams ?? {},
    pricing: options.pricing === null ? null : options.pricing ?? PRICING,
  });
  const modelVersion = getModelConfigVersion(ctx, model.modelConfigVersionId);
  return {
    projectId: ctx.projectId,
    prompts,
    variantA: prompts.find((item) => item.label === 'A'),
    variantB: prompts.find((item) => item.label === 'B'),
    testSetVersionId: imported.testSetVersionId,
    testSetHash: imported.contentHash,
    caseCount: imported.caseCount,
    evaluation,
    model,
    modelHash: modelVersion.contentHash,
    modelProfileId: modelVersion.profileId,
    modelVersionId: model.modelConfigVersionId,
  };
}

export function buildSpec(ctx, seed, overrides = {}) {
  const spec = {
    schema: 'promptlens.experiment/v1',
    projectId: ctx.projectId,
    name: '测试实验',
    variants: [
      { label: 'A', promptVersionId: seed.variantA.versionId, contentHash: seed.variantA.contentHash },
      { label: 'B', promptVersionId: seed.variantB.versionId, contentHash: seed.variantB.contentHash },
    ],
    testSet: { testSetVersionId: seed.testSetVersionId, contentHash: seed.testSetHash },
    models: [
      {
        modelConfigVersionId: seed.modelVersionId,
        modelProfileId: seed.modelProfileId,
        contentHash: seed.modelHash,
      },
    ],
    repetitions: 1,
    execution: { order: 'sequential', maxAttempts: 2, backoffBaseMs: 1, maxBackoffMs: 5, maxConcurrency: 2 },
    evaluation: { profileVersionId: seed.evaluation.profileVersionId, contentHash: seed.evaluation.contentHash },
    budget: { maxRequests: 100, maxDurationSeconds: 60 },
  };
  return deepMerge(spec, overrides);
}

export function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch;
  if (!patch || typeof patch !== 'object') return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(base?.[key], value);
  return out;
}
