import test from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestPromptOptimizations,
  listPromptSuggestions,
  getPromptSuggestion,
  parseSuggestionResponse,
  buildSuggestionContext,
  updatePromptSuggestionStatus,
} from '../src/core/prompt-suggestions.js';
import { createRun, executeRun } from '../src/core/run.js';
import { getPromptVersion } from '../src/core/assets.js';
import { createTempProject, seedProject, buildSpec } from './helpers.js';

test('提示词优化建议：基于运行证据生成并独立保存，不修改提示词', async () => {
  const env = createTempProject('优化建议');
  try {
    const seed = seedProject(env.ctx);
    const created = createRun(env.ctx, buildSpec(env.ctx, seed));
    await executeRun(env.ctx, created.runId);
    const before = getPromptVersion(env.ctx, seed.variantA.versionId).content;

    const context = buildSuggestionContext(env.ctx, {
      runId: created.runId,
      modelConfigVersionId: seed.modelVersionId,
      maxSuggestions: 3,
    });
    assert.equal(context.base.versionId, seed.variantA.versionId);
    assert.equal(context.evidenceCount, 4);
    assert.equal(context.cost.amount, '0.001');
    assert.ok(context.lowDimensions.some((dimension) => dimension.id === 'empathy'));
    assert.equal(listPromptSuggestions(env.ctx, { runId: created.runId }).length, 0);

    const result = await suggestPromptOptimizations(env.ctx, {
      runId: created.runId,
      modelConfigVersionId: seed.modelVersionId,
      maxSuggestions: 3,
    });
    assert.equal(result.promptUnchanged, true);
    assert.equal(result.status, 'generated');
    assert.equal(result.summary.meanScore, 0.5);
    assert.ok(result.suggestions.length >= 1);
    assert.ok(result.suggestions.length <= 3);
    assert.equal(result.base.versionId, seed.variantA.versionId);
    assert.ok(result.summary.trialCount > 0);
    assert.ok(result.suggestions.every((item) => item.issue && item.suggestion));
    const empathy = result.suggestions.find((item) => item.dimension === 'empathy');
    assert.ok(empathy);
    assert.match(empathy.issue, /共情/);
    assert.match(empathy.suggestion, /感谢/);
    assert.ok(empathy.evidence.length > 0);
    assert.equal(getPromptVersion(env.ctx, seed.variantA.versionId).content, before);

    const summary = listPromptSuggestions(env.ctx, { runId: created.runId });
    assert.equal(summary.length, 1);
    assert.equal(summary[0].suggestionCount, result.suggestions.length);
    const detail = getPromptSuggestion(env.ctx, result.suggestionId);
    assert.equal(detail.suggestions.length, result.suggestions.length);
    assert.equal(detail.contentHash, result.contentHash);
    assert.throws(() => getPromptSuggestion(env.ctx, 'missing'), (error) => error.code === 'NOT_FOUND_SUGGESTION');

    const accepted = updatePromptSuggestionStatus(env.ctx, result.suggestionId, 'accepted');
    assert.equal(accepted.status, 'accepted');
    assert.equal(listPromptSuggestions(env.ctx, { status: 'accepted' }).length, 1);
    assert.equal(listPromptSuggestions(env.ctx, { status: 'dismissed' }).length, 0);
    assert.throws(
      () => updatePromptSuggestionStatus(env.ctx, result.suggestionId, 'unknown'),
      (error) => error.code === 'VALIDATION_INVALID_REQUEST',
    );
  } finally {
    env.cleanup();
  }
});

test('提示词优化建议：未结束运行拒绝生成', async () => {
  const env = createTempProject('优化建议未结束');
  try {
    const seed = seedProject(env.ctx);
    const created = createRun(env.ctx, buildSpec(env.ctx, seed));
    await assert.rejects(
      () => suggestPromptOptimizations(env.ctx, { runId: created.runId, modelConfigVersionId: seed.modelVersionId }),
      (error) => error.code === 'STATE_INVALID_TRANSITION',
    );
  } finally {
    env.cleanup();
  }
});

test('优化建议解析：剥离代码围栏、过滤空项并附带维度证据', () => {
  const stats = [
    {
      id: 'accuracy',
      name: '准确性',
      lowTrials: [{ trialId: 't1', input: { question: '订单' }, output: '错误回答', score: 0.2 }],
    },
  ];
  const parsed = parseSuggestionResponse(
    '```json\n{"suggestions":[{"priority":"high","dimension":"accuracy","issue":"事实错误","suggestion":"补充核对","expectedImpact":"提升准确性"},{"issue":"","suggestion":"无效"}]}\n```',
    { stats, maxSuggestions: 3 },
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].priority, 'high');
  assert.equal(parsed[0].dimensionName, '准确性');
  assert.equal(parsed[0].evidence[0].trialId, 't1');
  assert.throws(() => parseSuggestionResponse('not json', { stats }), (error) => error.code === 'PROVIDER_INVALID_REQUEST');
});
