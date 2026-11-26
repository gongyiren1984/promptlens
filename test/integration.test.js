import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempProject, seedProject, buildSpec, PRICING } from './helpers.js';
import { projectHealth, projectSummary, createProject } from '../src/core/project.js';
import { openDatabase } from '../src/core/db.js';
import { createRegistry } from '../src/server/registry.js';
import {
  createRecoveryCopy,
  getRecoveryCopy,
  listRecoverableObjects,
  locateProjectRoot,
  updateRecentProject,
  updateProjectSettings,
} from '../src/core/project-admin.js';
import { importPrompts, listPrompts, getPromptVersion, diffPromptVersions, addVariant, restorePromptVersion } from '../src/core/assets.js';
import { importCases, listTestSets, parseCasesText, getTestSetByName } from '../src/core/cases.js';
import { addModel, listModels, testConnection, probeModels, getModelConfigVersion } from '../src/core/models.js';
import { createEvaluationProfile, validateEvaluationConfig } from '../src/eval/profile.js';
import { preflight, loadSpecFile } from '../src/core/spec.js';
import { createRun, executeRun, getRun, cancelRun, deriveRetryRun } from '../src/core/run.js';
import { generateReport, getReport, exportReport, listReports, DEFAULT_TEMPLATE } from '../src/core/report.js';
import { hashJson } from '../src/core/hash.js';

function assertEnvelope(envelope) {
  assert.equal(envelope.apiVersion, 'v1');
  assert.ok(typeof envelope.requestId === 'string' && envelope.requestId.length > 0);
  assert.ok(Array.isArray(envelope.warnings));
  assert.ok('error' in envelope);
  assert.ok(typeof envelope.meta.serverVersion === 'string');
  assert.ok(!Number.isNaN(Date.parse(envelope.meta.completedAt)));
}

function assertRunRecord(data) {
  const allowed = new Set(['counts', 'run', 'trials', 'outputs', 'events']);
  assert.deepEqual(Object.keys(data).filter((key) => !allowed.has(key)), []);
  const run = data.run;
  for (const field of ['id', 'projectId', 'snapshotId', 'snapshotHash', 'status', 'createdAt', 'updatedAt']) {
    assert.ok(run[field], `run.${field}`);
  }
  assert.ok(['draft', 'queued', 'running', 'paused', 'cancel_requested', 'completed', 'completed_with_errors', 'canceled', 'failed'].includes(run.status));
  for (const trial of data.trials) {
    assert.ok(['queued', 'running', 'retrying', 'completed', 'failed', 'canceled', 'aborted_unknown'].includes(trial.trialStatus));
    assert.ok(['not_available', 'valid', 'invalid_empty', 'invalid_truncated', 'invalid_format', 'policy_blocked'].includes(trial.outputValidity));
    assert.ok(['not_requested', 'pending', 'completed', 'incomplete', 'failed'].includes(trial.evaluationStatus));
    if (trial.trialStatus === 'completed') assert.notEqual(trial.outputValidity, 'not_available');
    if (['queued', 'running', 'retrying'].includes(trial.trialStatus)) {
      assert.equal(trial.outputValidity, 'not_available');
      assert.equal(trial.comparisonEligible, false);
    }
    if (trial.comparisonEligible) {
      assert.equal(trial.outputValidity, 'valid');
      assert.equal(trial.ineligibilityReasons.length, 0);
    } else {
      assert.ok(trial.ineligibilityReasons.length >= 1, '不可比必须给出原因');
    }
    for (const attempt of trial.attempts) {
      assert.ok(['in_flight', 'succeeded', 'failed', 'canceled', 'aborted_unknown'].includes(attempt.status));
      assert.ok(['known', 'unknown', 'not_applicable'].includes(attempt.billingState));
      if (attempt.status === 'failed') assert.ok(attempt.error?.code);
      if (attempt.fallbackUsed === false) assert.equal(attempt.crossModelSubstitution, false);
    }
  }
  const statusSum =
    data.counts.queued + data.counts.running + data.counts.retrying + data.counts.completed + data.counts.failed + data.counts.canceled + data.counts.abortedUnknown;
  assert.equal(statusSum, data.counts.total);
  assert.equal(data.counts.total, data.trials.length);
  assert.ok(data.counts.outputValid + data.counts.outputInvalid <= data.counts.total);
}

test('项目创建、健康检查与清单', () => {
  const env = createTempProject('健康检查');
  try {
    const health = projectHealth(env.ctx);
    assert.equal(health.status, 'ok');
    assert.equal(health.projectId, env.manifest.projectId);
    assert.equal(health.checks.find((check) => check.name === 'database_integrity').status, 'ok');
    const summary = projectSummary(env.ctx);
    assert.equal(summary.name, '健康检查');
    assert.equal(summary.counts.prompts, 0);
    assert.throws(() => createProject({ path: env.root, name: '重复' }), (error) => error.code === 'STATE_INVALID_TRANSITION');
  } finally {
    env.cleanup();
  }
});

test('工作区列表丢弃失效最近项目并为有效项补齐 root/counts', () => {
  const home = mkdtempSync(join(tmpdir(), 'promptlens-reg-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'promptlens-reg-ws-'));
  const env = createTempProject('最近项目');
  try {
    writeFileSync(
      join(home, 'recent-projects.json'),
      `${JSON.stringify({
        version: 1,
        projects: [
          { projectId: env.manifest.projectId, path: env.root, name: '最近项目', lastOpenedAt: '2026-01-02T00:00:00.000Z' },
          { projectId: 'missing', path: join(workspace, 'gone'), name: '已删除', lastOpenedAt: '2026-01-01T00:00:00.000Z' },
        ],
      })}\n`,
    );
    const registry = createRegistry({ workspaceRoot: workspace, home });
    try {
      const projects = registry.list().projects;
      assert.equal(projects.length, 1, '失效的最近项应被丢弃');
      assert.equal(projects[0].projectId, env.manifest.projectId);
      assert.equal(projects[0].root, env.root);
      assert.equal(typeof projects[0].counts.prompts, 'number');
    } finally {
      registry.close();
    }
  } finally {
    env.cleanup();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('恢复副本：只读清单列举资产，目录移动后可定位并修复索引', () => {
  const env = createTempProject('恢复测试');
  const home = mkdtempSync(join(tmpdir(), 'promptlens-recovery-'));
  try {
    seedProject(env.ctx);
    const copy = createRecoveryCopy({ root: env.root, home });
    assert.equal(copy.schema, 'promptlens.recovery/v1');
    assert.equal(copy.readonly, true);
    assert.equal(copy.databaseStatus, 'readable');
    assert.ok(copy.objects.counts.prompts >= 1);
    assert.ok(copy.objects.prompts.some((prompt) => prompt.name === '客服回复'));
    const reread = getRecoveryCopy(copy.path);
    assert.equal(reread.projectId, env.manifest.projectId);
    assert.equal(reread.objects.database, 'readable');

    const workspace = join(home, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const moved = join(workspace, 'moved-project');
    renameSync(env.root, moved);
    const found = locateProjectRoot({ projectId: env.manifest.projectId, searchRoots: [workspace] });
    assert.equal(found.root, moved);
    updateRecentProject(home, found);
    const recent = JSON.parse(readFileSync(join(home, 'recent-projects.json'), 'utf8'));
    assert.equal(recent.projects[0].path, moved);
    assert.equal(recent.projects[0].projectId, env.manifest.projectId);
  } finally {
    env.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test('恢复副本：数据库损坏时仍生成只读清单并标记为不可读', () => {
  const env = createTempProject('损坏恢复');
  const home = mkdtempSync(join(tmpdir(), 'promptlens-recovery-bad-'));
  try {
    seedProject(env.ctx);
    env.ctx.close();
    const dbPath = join(env.root, '.promptlens', 'db', 'project.sqlite3');
    writeFileSync(dbPath, 'not-a-sqlite-database');
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true });
    }
    const objects = listRecoverableObjects(env.root);
    assert.equal(objects.database, 'unreadable');
    assert.equal(objects.counts, null);
    const copy = createRecoveryCopy({ root: env.root, home });
    assert.equal(copy.databaseStatus, 'unreadable');
    assert.ok(existsSync(copy.manifestPath));
    assert.ok(existsSync(join(copy.path, 'promptlens.project.yaml')));
  } finally {
    env.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test('提示词版本幂等、变量提取与差异', () => {
  const env = createTempProject();
  try {
    const imported = importPrompts(env.ctx, {
      prompt: { name: '摘要' },
      variants: [
        { label: 'A', content: '请总结：{{text}}' },
        { label: 'B', content: '请用三点总结：{{text}}' },
      ],
    });
    assert.equal(imported.variants.length, 2);
    const a = imported.variants.find((item) => item.label === 'A');
    const version = getPromptVersion(env.ctx, a.versionId);
    assert.deepEqual(version.variables, ['text']);
    const same = addVariant(env.ctx, { promptName: '摘要', label: 'A', content: '请总结：{{text}}' });
    assert.equal(same.created, false);
    assert.equal(same.versionNumber, 1);
    const changed = addVariant(env.ctx, { promptName: '摘要', label: 'A', content: '请精炼总结：{{text}}' });
    assert.equal(changed.created, true);
    assert.equal(changed.versionNumber, 2);
    const diff = diffPromptVersions(env.ctx, a.versionId, changed.versionId);
    assert.equal(diff.identical, false);
    assert.ok(diff.lines.some((line) => line.type === 'add'));
    const restored = restorePromptVersion(env.ctx, a.versionId);
    assert.equal(restored.created, true);
    assert.equal(restored.versionNumber, 3);
    assert.equal(restored.restoredFromVersionId, a.versionId);
    assert.equal(getPromptVersion(env.ctx, restored.versionId).content, '请总结：{{text}}');
    const restoredAgain = restorePromptVersion(env.ctx, restored.versionId);
    assert.equal(restoredAgain.created, false);
    assert.equal(listPrompts(env.ctx)[0].variants.length, 2);
  } finally {
    env.cleanup();
  }
});

test('用例导入：CSV/JSONL、去重与原子失败', () => {
  const env = createTempProject();
  try {
    const csv = parseCasesText('input,expected,meta_json\n"你好, 世界",回复,"{""mock"":{""A"":""好的订单""}}"\n', 'csv');
    assert.equal(csv[0].input, '你好, 世界');
    const first = importCases(env.ctx, { records: csv, setName: '集合A' });
    assert.equal(first.imported, 1);
    assert.equal(first.caseCount, 1);
    const second = importCases(env.ctx, { records: csv, setName: '集合A' });
    assert.equal(second.imported, 0);
    assert.equal(second.duplicates, 1);
    assert.equal(second.newVersion, false);
    const jsonl = parseCasesText('{"input":{"q":"1"}}\n{"input":{"q":"2"}}\n', 'jsonl');
    const third = importCases(env.ctx, { records: jsonl, setName: '集合A' });
    assert.equal(third.caseCount, 3);
    assert.equal(third.versionNumber, 2);
    assert.throws(
      () => importCases(env.ctx, { records: [{ input: '' }, { input: 'ok' }], setName: '集合B' }),
      (error) => error.code === 'VALIDATION_INVALID_REQUEST' && error.details.totalErrors === 1,
    );
    assert.equal(listTestSets(env.ctx).length, 1);
    assert.equal(getTestSetByName(env.ctx, '集合A').cases.length, 3);
  } finally {
    env.cleanup();
  }
});

test('模型配置版本幂等、连接测试与价格校验', async () => {
  const env = createTempProject();
  try {
    const first = addModel(env.ctx, { name: 'mock', providerType: 'mock', modelId: 'm1', pricing: PRICING });
    const same = addModel(env.ctx, { name: 'mock', providerType: 'mock', modelId: 'm1', pricing: PRICING });
    assert.equal(first.created, true);
    assert.equal(same.created, false);
    const changed = addModel(env.ctx, { name: 'mock', providerType: 'mock', modelId: 'm2', pricing: PRICING });
    assert.equal(changed.versionNumber, 2);
    assert.equal(listModels(env.ctx)[0].versions.length, 2);
    const tested = await testConnection(env.ctx, 'mock');
    assert.equal(tested.ok, true);
    assert.ok(tested.sample.length > 0);
    assert.equal(tested.adapterVersion, 'mock/1');
    assert.equal(tested.capabilities.chat, true);
    const probed = await probeModels(env.ctx, 'mock');
    assert.deepEqual(probed.models.map((item) => item.id), ['m2']);
    assert.equal(probed.capabilities.modelList, false);
    assert.throws(
      () => addModel(env.ctx, {
        name: 'remote-http',
        providerType: 'openai_compatible',
        modelId: 'x',
        baseUrl: 'http://api.example.com/v1',
        credentialRef: 'env:OPENAI_API_KEY',
      }),
      (error) => error.code === 'VALIDATION_INVALID_REQUEST',
    );
    const local = addModel(env.ctx, {
      name: 'ollama',
      providerType: 'openai_compatible',
      modelId: 'llama3',
      baseUrl: 'http://127.0.0.1:11434/v1/',
      credentialRef: 'keychain:promptlens/ollama',
    });
    assert.equal(local.created, true);
    assert.equal(getModelConfigVersion(env.ctx, local.modelConfigVersionId).baseUrl, 'http://127.0.0.1:11434/v1');
    const remote = addModel(env.ctx, {
      name: 'remote',
      providerType: 'openai_compatible',
      modelId: 'gpt-test',
      baseUrl: 'https://api.example.com/v1',
    });
    const remoteProbe = await probeModels(env.ctx, remote.modelConfigVersionId, {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ data: [{ id: 'z-model' }, { id: 'a-model', owned_by: 'acme' }] }),
      }),
    });
    assert.deepEqual(remoteProbe.models.map((item) => item.id), ['a-model', 'z-model']);
    assert.equal(remoteProbe.capabilities.modelList, true);
    assert.equal(remoteProbe.adapterVersion, 'openai-compatible/1');
    assert.throws(
      () => addModel(env.ctx, { name: 'bad', providerType: 'openai_compatible', modelId: 'x', credentialRef: 'sk-secret' }),
      (error) => error.code === 'VALIDATION_INVALID_REQUEST',
    );
    assert.throws(
      () => addModel(env.ctx, { name: 'priced', providerType: 'mock', modelId: 'x', pricing: { currency: 'usd', unit: 'per_request', perRequest: '1' } }),
      (error) => error.code === 'VALIDATION_INVALID_REQUEST',
    );
  } finally {
    env.cleanup();
  }
});

test('评分配置校验与版本化', () => {
  const env = createTempProject();
  try {
    assert.throws(() => validateEvaluationConfig({ dimensions: [] }), (error) => error.code === 'VALIDATION_INVALID_REQUEST');
    assert.throws(
      () => validateEvaluationConfig({ dimensions: [{ id: 'a', name: 'A', weight: 1, rules: [{ type: 'regex', value: '(' }] }] }),
      (error) => error.code === 'VALIDATION_INVALID_REQUEST',
    );
    const created = createEvaluationProfile(env.ctx, {
      name: '规则',
      config: { dimensions: [{ id: 'a', name: 'A', weight: 1, rules: [{ type: 'min_length', value: 1 }] }] },
    });
    assert.equal(created.created, true);
    const again = createEvaluationProfile(env.ctx, {
      name: '规则',
      config: { dimensions: [{ id: 'a', name: 'A', weight: 1, rules: [{ type: 'min_length', value: 1 }] }] },
    });
    assert.equal(again.created, false);
  } finally {
    env.cleanup();
  }
});

test('预检阻断非法规格、缺失预算与未知价格金额上限', () => {
  const env = createTempProject();
  try {
    const seed = seedProject(env.ctx, { pricing: null });
    const valid = buildSpec(env.ctx, seed);
    assert.equal(preflight(env.ctx, valid).trialCount, 8);

    assert.throws(() => preflight(env.ctx, { ...valid, variants: [valid.variants[0]] }), (error) => error.code === 'VALIDATION_SCHEMA_INVALID');
    assert.throws(() => preflight(env.ctx, { ...valid, budget: {} }), (error) => error.code === 'VALIDATION_SCHEMA_INVALID');
    assert.throws(
      () => preflight(env.ctx, { ...valid, budget: { maxAmount: { amount: '1.00', currency: 'USD' } } }),
      (error) => error.code === 'BUDGET_PRICE_UNKNOWN',
    );
    assert.throws(
      () => createRun(env.ctx, { ...valid, budget: { maxRequests: 2 } }),
      (error) => error.code === 'BUDGET_EXCEEDED',
    );
  } finally {
    env.cleanup();
  }
});

test('完整运行、三轴状态、评估与不可变报告', async () => {
  const env = createTempProject();
  try {
    const seed = seedProject(env.ctx);
    const spec = buildSpec(env.ctx, seed, { repetitions: 2 });
    const plan = preflight(env.ctx, spec);
    assert.equal(plan.trialCount, 16);
    assert.ok(plan.snapshotHash.startsWith('sha256:'));

    const created = createRun(env.ctx, spec, { idempotencyKey: 'run-1' });
    assert.equal(created.trialCount, 16);
    const executed = await executeRun(env.ctx, created.runId);
    assert.equal(executed.status, 'completed');
    assert.equal(executed.stopReason, null);

    const data = getRun(env.ctx, created.runId, { includeOutputs: true });
    assertRunRecord(data);
    assert.equal(data.run.status, 'completed');
    assert.equal(data.counts.total, 16);
    assert.equal(data.counts.outputValid, 16);
    assert.equal(data.counts.comparisonEligible, 16);
    assert.equal(data.counts.failed, 0);
    assert.equal(Object.keys(data.outputs).length, 16);

    const evaluations = env.ctx.db
      .prepare('SELECT e.* FROM evaluations e JOIN trials t ON t.id = e.trial_id WHERE t.run_id = ?')
      .all(created.runId);
    assert.equal(evaluations.length, 16);
    assert.ok(evaluations.every((row) => row.status === 'completed'));
    const bScores = evaluations.filter((row) => row.overall_score === 1).length;
    assert.equal(bScores, 8);

    const report = generateReport(env.ctx, created.runId);
    assert.equal(report.status, 'generated');
    assert.match(report.contentHash, /^sha256:[a-f0-9]{64}$/);
    const absolute = join(env.root, report.path);
    assert.ok(existsSync(absolute));
    const markdown = readFileSync(absolute, 'utf8');
    const headings = markdown.split('\n').filter((line) => line.startsWith('## '));
    assert.equal(headings.length, 9);
    assert.match(markdown, /运行摘要/);
    assert.match(markdown, /不确定性/);
    assert.match(markdown, /限制与建议/);
    assert.match(markdown, /credentialRef/);

    const report2 = generateReport(env.ctx, created.runId);
    assert.notEqual(report2.reportId, report.reportId);
    assert.equal(readFileSync(absolute, 'utf8'), markdown);
    assert.equal(listReports(env.ctx, created.runId).length, 2);
    assert.equal(getReport(env.ctx, report.reportId).report.status, 'generated');
  } finally {
    env.cleanup();
  }
});

test('幂等键复用与请求体冲突', () => {
  const env = createTempProject();
  try {
    const seed = seedProject(env.ctx);
    const spec = buildSpec(env.ctx, seed);
    const first = createRun(env.ctx, spec, { idempotencyKey: 'same-key' });
    const second = createRun(env.ctx, spec, { idempotencyKey: 'same-key' });
    assert.equal(second.reused, true);
    assert.equal(second.runId, first.runId);
    assert.throws(
      () => createRun(env.ctx, { ...spec, name: '另一个实验' }, { idempotencyKey: 'same-key' }),
      (error) => error.code === 'STATE_IDEMPOTENCY_CONFLICT',
    );
  } finally {
    env.cleanup();
  }
});

test('无效输出与策略拦截：completed 不等于 valid', async () => {
  const env = createTempProject();
  try {
    const records = [
      { input: { question: '一' }, meta: { mock: { A: { content: '' }, B: '感谢您的耐心等待，订单已处理。' } } },
      { input: { question: '二' }, meta: { mock: { A: { content: '订单部分内容', finishReason: 'length' }, B: '感谢您的耐心等待，订单已处理。' } } },
      { input: { question: '三' }, meta: { mock: { A: '好的，订单已处理。', B: { errorCode: 'PROVIDER_POLICY_BLOCKED' } } } },
    ];
    const seed = seedProject(env.ctx, { cases: records });
    const spec = buildSpec(env.ctx, seed);
    const created = createRun(env.ctx, spec);
    const executed = await executeRun(env.ctx, created.runId);
    assert.equal(executed.status, 'completed');
    const data = getRun(env.ctx, created.runId);
    assertRunRecord(data);
    const byValidity = data.trials.map((trial) => trial.outputValidity).sort();
    assert.deepEqual(byValidity, ['invalid_empty', 'invalid_truncated', 'policy_blocked', 'valid', 'valid', 'valid']);
    const invalid = data.trials.filter((trial) => trial.outputValidity === 'invalid_empty');
    assert.equal(invalid[0].trialStatus, 'completed');
    assert.equal(invalid[0].comparisonEligible, false);
    assert.ok(invalid[0].ineligibilityReasons.includes('invalid_output'));
    assert.ok(data.trials.filter((trial) => !trial.comparisonEligible).every((trial) => trial.evaluationStatus !== 'completed'));
  } finally {
    env.cleanup();
  }
});

test('用户取消：停止后续 Trial 并保留已完成结果', async () => {
  const env = createTempProject();
  try {
    const records = Array.from({ length: 8 }, (_, index) => ({
      input: { question: `问题 ${index}` },
      meta: {
        mock: {
          A: { content: '好的，订单已处理。', latencyMs: 120 },
          B: { content: '感谢您的耐心等待，订单已处理。', latencyMs: 120 },
        },
      },
    }));
    const seed = seedProject(env.ctx, { cases: records });
    const spec = buildSpec(env.ctx, seed, { execution: { maxConcurrency: 2 } });
    const created = createRun(env.ctx, spec);
    const promise = executeRun(env.ctx, created.runId);
    await new Promise((resolve) => setTimeout(resolve, 130));
    cancelRun(env.ctx, created.runId);
    const executed = await promise;
    assert.equal(executed.status, 'canceled');
    assert.equal(executed.stopReason, 'user_cancel');
    const data = getRun(env.ctx, created.runId);
    assertRunRecord(data);
    assert.ok(data.counts.canceled > 0);
    assert.ok(data.counts.completed > 0);
    assert.ok(data.counts.canceled + data.counts.completed === data.counts.total);
  } finally {
    env.cleanup();
  }
});

test('运行期预算耗尽停止调度并给出 stopReason', async () => {
  const env = createTempProject();
  try {
    const seed = seedProject(env.ctx);
    const spec = buildSpec(env.ctx, seed, { budget: { maxTotalTokens: 1 }, execution: { maxConcurrency: 1 } });
    const created = createRun(env.ctx, spec);
    const executed = await executeRun(env.ctx, created.runId);
    assert.equal(executed.status, 'completed_with_errors');
    assert.equal(executed.stopReason, 'budget_exceeded');
    const data = getRun(env.ctx, created.runId);
    assertRunRecord(data);
    assert.ok(data.counts.canceled > 0);
    assert.ok(data.trials.some((trial) => trial.ineligibilityReasons.includes('budget_exhausted')));
  } finally {
    env.cleanup();
  }
});

test('跨模型 fallback 标记实际模型并排除对照', async () => {
  const env = createTempProject();
  try {
    const seed = seedProject(env.ctx, { modelParams: { mockFailureCode: 'PROVIDER_UNAVAILABLE' } });
    const fallback = addModel(env.ctx, {
      name: 'mock-fallback',
      providerType: 'mock',
      modelId: 'mock-backup',
      params: { mockAlwaysSucceed: true },
      pricing: PRICING,
    });
    const fallbackVersion = getModelConfigVersion(env.ctx, fallback.modelConfigVersionId);
    const spec = buildSpec(env.ctx, seed, {
      models: [
        {
          modelConfigVersionId: seed.modelVersionId,
          modelProfileId: seed.modelProfileId,
          contentHash: seed.modelHash,
          fallbackModelConfigVersionIds: [fallback.modelConfigVersionId],
        },
      ],
      execution: { maxAttempts: 2, backoffBaseMs: 1, maxBackoffMs: 2, maxConcurrency: 2 },
    });
    const created = createRun(env.ctx, spec);
    const executed = await executeRun(env.ctx, created.runId);
    assert.equal(executed.status, 'completed');
    const data = getRun(env.ctx, created.runId);
    assertRunRecord(data);
    assert.equal(data.counts.fallbackUsed, data.counts.total);
    assert.equal(data.counts.comparisonEligible, 0);
    for (const trial of data.trials) {
      assert.ok(trial.ineligibilityReasons.includes('cross_model_fallback'));
      const succeeded = trial.attempts.find((attempt) => attempt.status === 'succeeded');
      assert.equal(succeeded.actualModelConfigVersionId, fallback.modelConfigVersionId);
      assert.equal(succeeded.fallbackUsed, true);
      assert.equal(succeeded.crossModelSubstitution, true);
    }
    assert.ok(fallbackVersion.contentHash.startsWith('sha256:'));
  } finally {
    env.cleanup();
  }
});

test('retry-failed 派生新运行并保留父运行', async () => {
  const env = createTempProject();
  try {
    const seed = seedProject(env.ctx, { modelParams: { mockFailureCode: 'PROVIDER_INVALID_REQUEST' } });
    const spec = buildSpec(env.ctx, seed, { execution: { maxAttempts: 1, maxConcurrency: 2 } });
    const created = createRun(env.ctx, spec);
    const executed = await executeRun(env.ctx, created.runId);
    assert.equal(executed.status, 'completed_with_errors');
    assert.equal(executed.counts.failed, 8);
    const derived = deriveRetryRun(env.ctx, created.runId);
    assert.equal(derived.trialCount, 8);
    assert.equal(derived.parentRunId, created.runId);
    const retried = await executeRun(env.ctx, derived.runId);
    assert.equal(retried.status, 'completed_with_errors');
    const data = getRun(env.ctx, derived.runId);
    assert.equal(data.run.parentRunId, created.runId);
    assertRunRecord(data);
  } finally {
    env.cleanup();
  }
});

test('CLI 错误码与退出码契约', () => {
  const bin = join(process.cwd(), 'bin', 'promptlens.js');
  const missing = spawnSync(process.execPath, [bin, 'project', 'health', '--project', '/nonexistent-promptlens-project', '--json'], { encoding: 'utf8' });
  assert.equal(missing.status, 5);
  const missingEnvelope = JSON.parse(missing.stdout);
  assertEnvelope(missingEnvelope);
  assert.equal(missingEnvelope.ok, false);
  assert.equal(missingEnvelope.error.code, 'NOT_FOUND_PROJECT');

  const unknown = spawnSync(process.execPath, [bin, 'nope', 'x', '--json'], { encoding: 'utf8' });
  assert.equal(unknown.status, 3);
  assert.equal(JSON.parse(unknown.stdout).error.code, 'VALIDATION_INVALID_REQUEST');

  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /PromptLens CLI/);
});

test('审计事件覆盖提示词、用例、报告导出并记录 actor', async () => {
  const env = createTempProject('审计');
  try {
    const seed = seedProject(env.ctx);
    const created = createRun(env.ctx, buildSpec(env.ctx, seed));
    await executeRun(env.ctx, created.runId);
    const report = generateReport(env.ctx, created.runId);
    exportReport(env.ctx, report.reportId, join(env.root, 'exports', 'audit-report.md'));
    const events = env.ctx.db.prepare('SELECT type, actor FROM audit_events ORDER BY created_at').all();
    const types = events.map((event) => event.type);
    for (const type of ['prompt.imported', 'cases.imported', 'evaluation_profile.created', 'run.created', 'report.generated', 'report.exported']) {
      assert.ok(types.includes(type), `缺少审计事件 ${type}`);
    }
    assert.ok(events.every((event) => event.actor === 'cli'), '默认 actor 应为 cli');
    const exported = events.find((event) => event.type === 'report.exported');
    assert.equal(exported.actor, 'cli');
  } finally {
    env.cleanup();
  }
});

test('报告脱敏应用项目敏感字段设置', async () => {
  const env = createTempProject('脱敏报告');
  try {
    const seed = seedProject(env.ctx);
    const updated = updateProjectSettings(env.ctx, { sensitiveFields: ['感谢', 'regex:1\\d{10}'] });
    assert.deepEqual(updated.sensitiveFields, ['感谢', 'regex:1\\d{10}']);
    assert.throws(
      () => updateProjectSettings(env.ctx, { sensitiveFields: ['regex:('] }),
      (error) => error.code === 'VALIDATION_INVALID_REQUEST',
    );
    const created = createRun(env.ctx, buildSpec(env.ctx, seed));
    await executeRun(env.ctx, created.runId);
    const report = generateReport(env.ctx, created.runId);
    const markdown = readFileSync(join(env.root, report.path), 'utf8');
    assert.ok(!markdown.includes('感谢'), '用户敏感字段应被脱敏');
    assert.ok(report.redactions.includes('field:感谢'));
    assert.ok(report.redactions.includes('regex:1\\d{10}'));
  } finally {
    env.cleanup();
  }
});

test('自定义报告模板缺少必备章节被阻断', () => {
  const env = createTempProject();
  try {
    const seed = seedProject(env.ctx);
    const spec = buildSpec(env.ctx, seed);
    const created = createRun(env.ctx, spec);
    return executeRun(env.ctx, created.runId).then(() => {
      const badTemplate = {
        ...DEFAULT_TEMPLATE,
        sections: DEFAULT_TEMPLATE.sections.filter((section) => section.id !== 'uncertainty'),
        variables: [],
      };
      assert.throws(
        () => generateReport(env.ctx, created.runId, { template: badTemplate }),
        (error) => error.code === 'VALIDATION_REPORT_TEMPLATE_INVALID',
      );
    }).finally(() => env.cleanup());
  } catch (error) {
    env.cleanup();
    throw error;
  }
});

test('SQLite 事务回滚与完整性检查', () => {
  const env = createTempProject();
  try {
    const db = openDatabase(join(env.root, '.promptlens', 'db', 'project.sqlite3'));
    try {
      db.exec('BEGIN');
      db.prepare('INSERT INTO prompts(id, project_id, name, created_at) VALUES(?,?,?,?)').run('x1', env.ctx.projectId, '回滚提示词', new Date().toISOString());
      db.exec('ROLLBACK');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prompts').get().n, 0);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally {
      db.close();
    }
  } finally {
    env.cleanup();
  }
});

test('YAML 实验规格可被加载', async () => {
  const env = createTempProject();
  try {
    const seed = seedProject(env.ctx);
    const spec = buildSpec(env.ctx, seed);
    const { writeFileSync } = await import('node:fs');
    const yaml = `${Object.entries({
      schema: spec.schema,
      projectId: spec.projectId,
      name: spec.name,
      variants: spec.variants,
      testSet: spec.testSet,
      models: spec.models,
      repetitions: spec.repetitions,
      execution: spec.execution,
      evaluation: spec.evaluation,
      budget: spec.budget,
    }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n`;
    const path = join(env.root, 'spec.yaml');
    writeFileSync(path, yaml, 'utf8');
    const loaded = loadSpecFile(path);
    assert.deepEqual(loaded, spec);
    assert.equal(hashJson(loaded), hashJson(spec));
  } finally {
    env.cleanup();
  }
});
