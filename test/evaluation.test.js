import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEvaluationProfile, getEvaluationProfileVersion, listEvaluationProfiles, validateEvaluationConfig } from '../src/eval/profile.js';
import { buildJudgeMessages, parseJudgeResponse } from '../src/eval/judge.js';
import { preflight } from '../src/core/spec.js';
import { createRun, executeRun } from '../src/core/run.js';
import { generateReport } from '../src/core/report.js';
import { listEvaluations } from '../src/eval/engine.js';
import { runCostSummary } from '../src/core/insights.js';
import { createTempProject, seedProject, buildSpec } from './helpers.js';

const SCALE_CONFIG = {
  schema: 'promptlens.evaluation-profile/v1',
  scale: { min: 1, max: 5, anchors: { 1: '完全错误', 3: '部分正确', 5: '完全正确' } },
  dimensions: [
    { id: 'accuracy', name: '准确性', weight: 2, gating: true, gate: 0.5, rules: [{ type: 'contains', value: '订单' }] },
    { id: 'empathy', name: '共情', weight: 1, rules: [{ type: 'contains', value: '感谢' }] },
  ],
};

test('评分配置：刻度、锚点、硬门槛与权重归一化', () => {
  const env = createTempProject();
  try {
    assert.throws(() => validateEvaluationConfig({ ...SCALE_CONFIG, scale: { min: 1, max: 7 } }), (error) => error.code === 'VALIDATION_INVALID_REQUEST');
    assert.throws(
      () => validateEvaluationConfig({ ...SCALE_CONFIG, scale: { min: 1, max: 5, anchors: { 9: '越界' } } }),
      (error) => error.code === 'VALIDATION_INVALID_REQUEST',
    );
    assert.throws(
      () => validateEvaluationConfig({ dimensions: [{ id: 'a', name: 'A', weight: 1, gating: true, rules: [{ type: 'min_length', value: 1 }] }] }),
      (error) => error.code === 'VALIDATION_INVALID_REQUEST',
    );

    const created = createEvaluationProfile(env.ctx, { name: '带刻度', config: SCALE_CONFIG });
    assert.equal(created.created, true);
    const version = getEvaluationProfileVersion(env.ctx, created.profileVersionId);
    assert.equal(version.scale.max, 5);
    assert.equal(version.weightTotal, 3);
    assert.equal(version.normalizedWeights.accuracy, 2 / 3);
    assert.equal(version.normalizedWeights.empathy, 1 / 3);

    const list = listEvaluationProfiles(env.ctx);
    assert.equal(list[0].scale.max, 5);
    assert.equal(list[0].weightTotal, 3);
    assert.equal(list[0].dimensions[0].normalizedWeight, 2 / 3);

    const builtIn = createEvaluationProfile(env.ctx, { name: '内置 Rubric', template: 'default' });
    const builtInVersion = getEvaluationProfileVersion(env.ctx, builtIn.profileVersionId);
    assert.equal(builtIn.created, true);
    assert.equal(builtInVersion.config.dimensions.length, 3);
    assert.equal(builtInVersion.scale.max, 5);
    assert.equal(builtInVersion.normalizedWeights.accuracy, 0.5);
  } finally {
    env.cleanup();
  }
});

test('judge 提示词包含锚点，返回值按刻度归一化', () => {
  const messages = buildJudgeMessages({
    dimensions: [{ id: 'accuracy', name: '准确性' }],
    content: '订单已处理',
    caseInput: { question: '订单' },
    expected: null,
    instructions: null,
    scale: { min: 1, max: 5, anchors: { 1: '完全错误', 5: '完全正确' } },
  });
  assert.match(messages[1].content, /1—5/);
  assert.match(messages[1].content, /1=完全错误/);
  const parsed = parseJudgeResponse('{"scores":{"accuracy":5,"empathy":3,"safety":0,"other":7}}', { min: 1, max: 5 });
  assert.equal(parsed.scores.accuracy, 1);
  assert.equal(parsed.scores.empathy, 0.5);
  assert.equal(parsed.scores.safety, 0);
  assert.equal(parsed.scores.other, 1);
  assert.equal(parseJudgeResponse('{"scores":{"x":1.4}}').scores.x, 1);
});

test('预检展示归一化权重，报告按刻度展示分维度结果且旧报告不变', async () => {
  const env = createTempProject();
  try {
    const seed = seedProject(env.ctx, { evalConfig: SCALE_CONFIG, evalName: '刻度规则' });
    const spec = buildSpec(env.ctx, seed);
    const plan = preflight(env.ctx, spec);
    assert.equal(plan.plan.evaluation.scale.max, 5);
    assert.equal(plan.plan.evaluation.weightTotal, 3);
    assert.equal(plan.plan.evaluation.weights[0].normalizedWeight, 2 / 3);
    assert.ok(plan.warnings.some((warning) => warning.code === 'WEIGHTS_NORMALIZED'));

    const created = createRun(env.ctx, spec);
    const executed = await executeRun(env.ctx, created.runId);
    assert.equal(executed.status, 'completed');
    const report = generateReport(env.ctx, created.runId);
    const markdown = readFileSync(join(env.root, report.path), 'utf8');
    assert.match(markdown, /评分刻度：1—5/);
    assert.match(markdown, /66\.7%/);
    assert.match(markdown, /完全正确/);
    assert.match(markdown, /\| 准确性 \|/);
    assert.match(markdown, /5\.0/);

    const v2 = createEvaluationProfile(env.ctx, {
      name: '刻度规则',
      config: { ...SCALE_CONFIG, dimensions: SCALE_CONFIG.dimensions.map((dimension) => ({ ...dimension, weight: 1 })) },
    });
    assert.equal(v2.versionNumber, 2);
    const unchanged = generateReport(env.ctx, created.runId);
    assert.equal(unchanged.contentHash, report.contentHash);
    assert.equal(readFileSync(join(env.root, report.path), 'utf8'), markdown);
    assert.match(markdown, new RegExp(seed.evaluation.profileVersionId));
  } finally {
    env.cleanup();
  }
});

test('judge 原始响应与一致性被持久化，报告展示评审波动与用量', async () => {
  const env = createTempProject();
  try {
    const judgeConfig = {
      ...SCALE_CONFIG,
      judge: { enabled: true, defaultInstructions: '你是评审。' },
    };
    const seed = seedProject(env.ctx, {
      evalConfig: judgeConfig,
      modelParams: { mockJudgeScoresSequence: [{ accuracy: 5, empathy: 5 }, { accuracy: 1, empathy: 1 }] },
    });
    const spec = buildSpec(env.ctx, seed, {
      evaluation: { judgeRepetitions: 2, judgeModelConfigVersionId: seed.modelVersionId },
    });
    const created = createRun(env.ctx, spec);
    const executed = await executeRun(env.ctx, created.runId);
    assert.equal(executed.status, 'completed');

    const evaluations = listEvaluations(env.ctx, created.runId);
    const completed = evaluations.find((evaluation) => evaluation.status === 'completed');
    assert.ok(completed, '应有可比较的已完成评估');
    const detail = completed.scores.details.accuracy;
    assert.equal(detail.judgeRuns.length, 2);
    assert.match(detail.judgeRuns[0].content, /"scores"/);
    assert.equal(detail.judgeRuns[0].modelId, 'mock-large');
    assert.equal(detail.judgeRuns[0].finishReason, 'stop');
    assert.ok(detail.judgeRuns[0].usage.inputTokens > 0);
    assert.equal(detail.judgeConsistency, 0, '5 与 1 的评分差为 1.0，一致性应为 0');
    assert.equal(completed.scores.judgeConsistency, 0);
    assert.equal(completed.scores.judgeUsage.length, 4, '两个维度各重复 2 次');
    assert.equal(completed.scores.judgeModelConfigVersionId, seed.modelVersionId);

    const report = generateReport(env.ctx, created.runId);
    const markdown = readFileSync(join(env.root, report.path), 'utf8');
    assert.match(markdown, /评审模型（judge）：\d+ 次调用/);
    assert.match(markdown, /评审模型评分一致性均值 0\.000/);
    assert.match(markdown, /JUDGE_UNSTABLE/);
    assert.ok(report.warnings.some((warning) => warning.code === 'JUDGE_UNSTABLE'));

    const cost = runCostSummary(env.ctx, created.runId);
    assert.equal(cost.judge.enabled, true);
    assert.equal(cost.judge.calls, 32, '8 个 Trial × 2 维度 × 2 次重复');
    assert.equal(cost.judge.complete, true);
    assert.ok(cost.byModel.some((entry) => entry.name.includes('(judge)')));
    assert.ok(cost.amount != null);
  } finally {
    env.cleanup();
  }
});
