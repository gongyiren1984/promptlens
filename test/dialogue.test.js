import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addModel, getModelConfigVersion } from '../src/core/models.js';
import { createRun, executeRun, getRun } from '../src/core/run.js';
import { preflight } from '../src/core/spec.js';
import { runBundle, runCostSummary } from '../src/core/insights.js';
import { createTempProject, seedProject, buildSpec, deepMerge, PRICING } from './helpers.js';

function seedDialogue(ctx, { generatorContent, candidateA, candidateB, caseInput = { question: '订单什么时候到？' } }) {
  const seed = seedProject(ctx, {
    cases: [
      {
        input: caseInput,
        meta: {
          mock: {
            generator: { content: generatorContent },
            A: { content: candidateA ?? ['A-回答一', 'A-回答二', 'A-回答三', 'A-回答四'] },
            B: { content: candidateB ?? ['B-回答一', 'B-回答二', 'B-回答三', 'B-回答四'] },
          },
        },
      },
    ],
  });
  const generator = addModel(ctx, {
    name: 'mock-generator',
    providerType: 'mock',
    modelId: 'mock-generator',
    pricing: PRICING,
  });
  const generatorVersion = getModelConfigVersion(ctx, generator.modelConfigVersionId);
  return { seed, generatorVersionId: generator.modelConfigVersionId, generatorHash: generatorVersion.contentHash };
}

function dialogueSpec(ctx, seed, generatorVersionId, dialogue, overrides = {}) {
  return buildSpec(
    ctx,
    seed,
    deepMerge(
      {
        execution: {
          maxConcurrency: 1,
          maxAttempts: 1,
          backoffBaseMs: 1,
          maxBackoffMs: 5,
          dialogue: { generatorModelConfigVersionId: generatorVersionId, ...dialogue },
        },
      },
      overrides,
    ),
  );
}

async function runOnce(ctx, spec) {
  const created = createRun(ctx, spec, { idempotencyKey: `dialogue-${Math.random()}` });
  await executeRun(ctx, created.runId);
  return { created, run: getRun(ctx, created.runId, { includeOutputs: true }) };
}

test('多轮对话：达到最大轮数停止，并逐轮持久化 A/B 转录', async () => {
  const subject = createTempProject('对话轮数');
  try {
    const ctx = subject.ctx;
    const { seed, generatorVersionId } = seedDialogue(ctx, { generatorContent: ['追问一'] });
    const spec = dialogueSpec(ctx, seed, generatorVersionId, { maxRounds: 2, initialInputPolicy: 'case_first' });
    const { run } = await runOnce(ctx, spec);

    const trial = run.trials[0];
    assert.equal(trial.trialStatus, 'completed');
    assert.deepEqual(
      trial.dialogueTurns.map((turn) => `${turn.round}:${turn.role}`),
      ['1:candidate', '2:generator', '2:candidate'],
    );
    assert.equal(run.outputs[trial.id].dialogue.terminationReason, 'round_limit');
    assert.equal(run.outputs[trial.id].dialogue.rounds, 2);
    assert.equal(run.outputs[trial.id].dialogue.turns, 3);
    assert.equal(trial.comparisonEligible, true);
  } finally {
    subject.cleanup();
  }
});

test('多轮对话：B 输出 <END> 时在第 3 轮停止，A 转录完整保存', async () => {
  const subject = createTempProject('对话终止标记');
  try {
    const ctx = subject.ctx;
    const { seed, generatorVersionId } = seedDialogue(ctx, { generatorContent: ['追问一', '<END>'] });
    const spec = dialogueSpec(ctx, seed, generatorVersionId, { maxRounds: 5 });
    const { run } = await runOnce(ctx, spec);

    const trial = run.trials[0];
    assert.deepEqual(
      trial.dialogueTurns.map((turn) => `${turn.round}:${turn.role}`),
      ['1:candidate', '2:generator', '2:candidate', '3:generator'],
    );
    assert.equal(trial.dialogueTurns.at(-1).content, '<END>');
    assert.equal(trial.dialogueTurns.at(-1).terminationReason, 'termination_literal');
    assert.equal(run.outputs[trial.id].dialogue.terminationReason, 'termination_literal');
    assert.equal(trial.dialogueTurns.filter((turn) => turn.role === 'candidate').length, 2);
  } finally {
    subject.cleanup();
  }
});

test('多轮对话：正则终止条件在 B 输出匹配时停止', async () => {
  const subject = createTempProject('对话正则终止');
  try {
    const ctx = subject.ctx;
    const { seed, generatorVersionId } = seedDialogue(ctx, { generatorContent: ['DONE-42'] });
    const spec = dialogueSpec(ctx, seed, generatorVersionId, {
      maxRounds: 5,
      termination: [{ type: 'regex', value: 'DONE-\\d+' }],
    });
    const { run } = await runOnce(ctx, spec);

    const trial = run.trials[0];
    assert.equal(run.outputs[trial.id].dialogue.terminationReason, 'termination_regex');
    assert.equal(trial.dialogueTurns.filter((turn) => turn.role === 'generator').length, 1);
  } finally {
    subject.cleanup();
  }
});

test('多轮对话：JSON 条件终止条件在 B 输出满足时停止', async () => {
  const subject = createTempProject('对话JSON终止');
  try {
    const ctx = subject.ctx;
    const { seed, generatorVersionId } = seedDialogue(ctx, { generatorContent: ['{"status":"done"}'] });
    const spec = dialogueSpec(ctx, seed, generatorVersionId, {
      maxRounds: 5,
      termination: [{ type: 'json_condition', value: '{"path":"status","equals":"done"}' }],
    });
    const { run } = await runOnce(ctx, spec);

    const trial = run.trials[0];
    assert.equal(run.outputs[trial.id].dialogue.terminationReason, 'termination_json_condition');
    assert.equal(trial.dialogueTurns.at(-1).role, 'generator');
  } finally {
    subject.cleanup();
  }
});

test('多轮对话：预算耗尽时停止并保留已产生转录', async () => {
  const subject = createTempProject('对话预算');
  try {
    const ctx = subject.ctx;
    const { seed, generatorVersionId } = seedDialogue(ctx, { generatorContent: ['追问一', '追问二'] });
    const spec = dialogueSpec(
      ctx,
      seed,
      generatorVersionId,
      { maxRounds: 5 },
      { budget: { maxRequests: 2, maxDurationSeconds: 60 } },
    );
    const { run } = await runOnce(ctx, spec);

    const trial = run.trials.find((item) => item.outputValidity === 'valid');
    assert.ok(trial, '至少一个 Trial 留下最终回答');
    assert.equal(run.outputs[trial.id].dialogue.terminationReason, 'budget_exhausted');
    assert.ok(trial.dialogueTurns.length >= 2);
    assert.equal(trial.comparisonEligible, false);
    assert.ok(trial.ineligibilityReasons.includes('budget_exhausted'));
  } finally {
    subject.cleanup();
  }
});

test('多轮对话：每个 Trial 使用独立上下文，转录互不串扰', async () => {
  const subject = createTempProject('对话隔离');
  try {
    const ctx = subject.ctx;
    const { seed, generatorVersionId } = seedDialogue(ctx, { generatorContent: ['追问一'] });
    const spec = dialogueSpec(ctx, seed, generatorVersionId, { maxRounds: 2 });
    const { run } = await runOnce(ctx, spec);

    assert.equal(run.trials.length, 2);
    const candidateContents = run.trials.map((trial) =>
      trial.dialogueTurns.filter((turn) => turn.role === 'candidate').map((turn) => turn.content),
    );
    assert.deepEqual(candidateContents[0], ['A-回答一', 'A-回答二']);
    assert.deepEqual(candidateContents[1], ['B-回答一', 'B-回答二']);
    const turnIds = new Set(run.trials.flatMap((trial) => trial.dialogueTurns.map((turn) => turn.id)));
    assert.equal(turnIds.size, 6);
  } finally {
    subject.cleanup();
  }
});

test('多轮对话：generator_first 由 B 生成第一轮输入', async () => {
  const subject = createTempProject('对话B先手');
  try {
    const ctx = subject.ctx;
    const { seed, generatorVersionId } = seedDialogue(ctx, { generatorContent: ['初始问题'] });
    const spec = dialogueSpec(ctx, seed, generatorVersionId, { maxRounds: 2, initialInputPolicy: 'generator_first' });
    const { run } = await runOnce(ctx, spec);

    const trial = run.trials[0];
    assert.deepEqual(
      trial.dialogueTurns.map((turn) => `${turn.round}:${turn.role}`),
      ['1:generator', '1:candidate', '2:generator', '2:candidate'],
    );
    assert.equal(trial.dialogueTurns[0].content, '初始问题');
  } finally {
    subject.cleanup();
  }
});

test('多轮对话：非法配置在预检阶段被拒绝', () => {
  const subject = createTempProject('对话校验');
  try {
    const ctx = subject.ctx;
    const { seed, generatorVersionId } = seedDialogue(ctx, { generatorContent: ['追问一'] });

    assert.throws(
      () => preflight(ctx, dialogueSpec(ctx, seed, generatorVersionId, { maxRounds: 21 })),
      (error) =>
        error.code === 'VALIDATION_SCHEMA_INVALID' &&
        error.details.errors.some((item) => item.path.includes('maxRounds')),
    );
    assert.throws(
      () =>
        preflight(
          ctx,
          dialogueSpec(ctx, seed, generatorVersionId, {
            maxRounds: 2,
            termination: [{ type: 'regex', value: '[' }],
          }),
        ),
      (error) =>
        error.code === 'VALIDATION_SCHEMA_INVALID' &&
        error.details.errors.some((item) => item.message.includes('正则非法')),
    );
    assert.throws(
      () =>
        preflight(
          ctx,
          dialogueSpec(ctx, seed, generatorVersionId, {
            maxRounds: 2,
            generatorModelConfigVersionId: 'missing-generator',
          }),
        ),
      /模型配置版本不存在/,
    );
  } finally {
    subject.cleanup();
  }
});

test('多轮对话：runBundle 暴露转录与快照摘要', async () => {
  const subject = createTempProject('对话契约');
  try {
    const ctx = subject.ctx;
    const { seed, generatorVersionId } = seedDialogue(ctx, { generatorContent: ['追问一'] });
    const spec = dialogueSpec(ctx, seed, generatorVersionId, { maxRounds: 2, maxOutputTokensPerTurn: 128 });
    const { created } = await runOnce(ctx, spec);

    const bundle = runBundle(ctx, created.runId, { includeOutputs: true });
    assert.equal(bundle.snapshotSummary.execution.dialogue.maxRounds, 2);
    assert.equal(bundle.snapshotSummary.execution.dialogue.generatorModel, 'mock-generator');
    assert.equal(bundle.snapshotSummary.execution.dialogue.maxOutputTokensPerTurn, 128);
    assert.equal(bundle.snapshotSummary.execution.dialogue.callsPerTrial, 3);
    assert.equal(bundle.trials[0].dialogueTurns.length, 3);
    assert.ok(bundle.outputs[bundle.trials[0].id].dialogue);

    const cost = runCostSummary(ctx, created.runId);
    const byModel = Object.fromEntries(cost.byModel.map((item) => [item.name, item]));
    assert.ok(byModel['mock-generator'], '成本汇总包含生成模型');
    assert.ok(byModel['mock-generator'].requests >= 2);
    assert.equal(cost.complete, true);
  } finally {
    subject.cleanup();
  }
});
