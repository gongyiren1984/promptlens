import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIterationContext, proposePromptIteration, deriveVerificationSpec } from '../src/core/prompt-iteration.js';
import { createRun, executeRun } from '../src/core/run.js';
import { getPromptVersion } from '../src/core/assets.js';
import { loadSnapshot } from '../src/core/spec.js';
import { createTempProject, seedProject, buildSpec } from './helpers.js';

test('提示词迭代：生成前预览证据、成本与轮数上限', async () => {
  const env = createTempProject('迭代预览');
  try {
    const seed = seedProject(env.ctx);
    const created = createRun(env.ctx, buildSpec(env.ctx, seed));
    await executeRun(env.ctx, created.runId);

    const context = buildIterationContext(env.ctx, { runId: created.runId, modelConfigVersionId: seed.modelVersionId, rounds: 2 });
    assert.equal(context.rounds.requested, 2);
    assert.equal(context.rounds.max, 3);
    assert.ok(context.evidence.variants.length >= 2);
    assert.ok(context.evidence.lowScores.length > 0);
    assert.equal(context.cost.amount, '0.002');
    assert.equal(context.cost.currency, 'USD');
    assert.equal(context.verification.requiresSave, true);
  } finally {
    env.cleanup();
  }
});

test('提示词迭代：多轮候选各自生成 diff，保存后每轮创建独立验证 Run 与报告', async () => {
  const env = createTempProject('迭代闭环');
  try {
    const seed = seedProject(env.ctx);
    const created = createRun(env.ctx, buildSpec(env.ctx, seed));
    await executeRun(env.ctx, created.runId);

    const multi = await proposePromptIteration(env.ctx, {
      runId: created.runId,
      modelConfigVersionId: seed.modelVersionId,
      instruction: '减少猜测',
      rounds: 2,
    });
    assert.equal(multi.rounds.length, 2);
    assert.equal(multi.rounds[0].round, 1);
    assert.notEqual(multi.rounds[0].content, multi.rounds[1].content);
    assert.equal(multi.rounds[0].verification.status, 'unverified');
    assert.equal(multi.proposal.versionId, null);

    const verified = await proposePromptIteration(env.ctx, {
      runId: created.runId,
      modelConfigVersionId: seed.modelVersionId,
      instruction: '减少猜测',
      rounds: 2,
      save: true,
      verify: true,
      inline: true,
    });
    assert.ok(verified.proposal.versionId);
    assert.equal(verified.verification.length, 2);
    assert.equal(verified.verification[0].verificationStatus, 'unverified');
    for (const item of verified.verification) {
      assert.ok(item.runId);
      assert.ok(item.reportId);
      assert.equal(item.status, 'completed');
    }
    assert.equal(getPromptVersion(env.ctx, verified.base.versionId).content, verified.base.content);

    const verificationRuns = env.ctx.db.prepare('SELECT * FROM runs WHERE parent_run_id = ? ORDER BY created_at').all(created.runId);
    assert.equal(verificationRuns.length, 2);
    assert.ok(verificationRuns.every((run) => run.status === 'completed'));
    const reports = env.ctx.db
      .prepare('SELECT * FROM reports WHERE run_id IN (?,?)')
      .all(verificationRuns[0].id, verificationRuns[1].id);
    assert.equal(reports.length, 2);
  } finally {
    env.cleanup();
  }
});

test('验证规格复用源快照的测试集、模型与评分方案', async () => {
  const env = createTempProject('迭代规格');
  try {
    const seed = seedProject(env.ctx);
    const created = createRun(env.ctx, buildSpec(env.ctx, seed));
    await executeRun(env.ctx, created.runId);
    const run = env.ctx.db.prepare('SELECT * FROM runs WHERE id = ?').get(created.runId);
    const snapshot = loadSnapshot(env.ctx, run.snapshot_id);
    assert.equal(snapshot.models[0].adapterVersion, 'mock/1');
    assert.equal(snapshot.models[0].capabilities.chat, true);
    assert.equal(snapshot.models[0].capabilities.streaming, false);
    const spec = deriveVerificationSpec(snapshot, {
      baseVersionId: seed.variantA.versionId,
      candidateVersionId: seed.variantB.versionId,
      candidateLabel: 'A-candidate',
      candidateContentHash: seed.variantB.contentHash,
      round: 1,
    });
    assert.equal(spec.variants.length, 2);
    assert.equal(spec.variants[1].label, 'A-candidate');
    assert.equal(spec.testSet.testSetVersionId, snapshot.spec.testSet.testSetVersionId);
    assert.equal(spec.models[0].modelConfigVersionId, seed.modelVersionId);
    assert.equal(spec.evaluation.profileVersionId, seed.evaluation.profileVersionId);
    assert.equal(spec.budget.maxRequests, 8);
    assert.equal(spec.name.includes('迭代验证 R1'), true);
  } finally {
    env.cleanup();
  }
});
