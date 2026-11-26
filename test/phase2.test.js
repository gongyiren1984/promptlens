import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addModel, getModelConfigVersion } from '../src/core/models.js';
import { createRun, executeRun, cancelRun, getRun } from '../src/core/run.js';
import { listRuns, runCostSummary } from '../src/core/insights.js';
import { listReports } from '../src/core/report.js';
import { finalizeRunArtifacts } from '../src/core/auto-report.js';
import { generateCases, parseCandidates } from '../src/core/case-generation.js';
import { createImportPreview, commitImportPreview } from '../src/core/import-preview.js';
import { proposePromptIteration } from '../src/core/prompt-iteration.js';
import { getLibraryEntry, importLibraryEntry, listLibrary, promoteTestSet, testSetOrigin } from '../src/core/library.js';
import { listTestSets } from '../src/core/cases.js';
import { getPromptVersion } from '../src/core/assets.js';
import {
  BACKUP_METADATA_NAME,
  backupProject,
  deleteProject,
  importProject,
  listTrash,
  projectSettings,
  renameProject,
  restoreTrash,
  setProjectArchived,
  updateProjectSettings,
} from '../src/core/project-admin.js';
import { createTempProject, seedProject, buildSpec } from './helpers.js';

test('自动报告闭环：默认写入 exports，可降级为仅预览，关闭后不生成', async () => {
  const subject = createTempProject('自动报告项目');
  const home = mkdtempSync(join(tmpdir(), 'promptlens-auto-report-'));
  try {
    const ctx = subject.ctx;
    const seed = seedProject(ctx);

    const first = createRun(ctx, buildSpec(ctx, seed), { idempotencyKey: 'auto-report-1' });
    await executeRun(ctx, first.runId);
    const firstArtifacts = finalizeRunArtifacts(ctx, first.runId);
    assert.equal(firstArtifacts.generated, true);
    assert.equal(firstArtifacts.exported, true);
    assert.ok(firstArtifacts.path.startsWith('exports/reports/'));

    updateProjectSettings(ctx, { autoExport: false });
    const second = createRun(ctx, buildSpec(ctx, seed), { idempotencyKey: 'auto-report-2' });
    await executeRun(ctx, second.runId);
    const secondArtifacts = finalizeRunArtifacts(ctx, second.runId);
    assert.equal(secondArtifacts.generated, true);
    assert.equal(secondArtifacts.exported, false);
    assert.ok(secondArtifacts.path.startsWith('.promptlens/reports/'));

    // 同一 Run 不重复生成，重复调用返回已有报告
    const again = finalizeRunArtifacts(ctx, second.runId);
    assert.equal(again.generated, false);
    assert.equal(again.reason, 'exists');

    updateProjectSettings(ctx, { autoReport: false });
    const third = createRun(ctx, buildSpec(ctx, seed), { idempotencyKey: 'auto-report-3' });
    await executeRun(ctx, third.runId);
    const thirdArtifacts = finalizeRunArtifacts(ctx, third.runId);
    assert.equal(thirdArtifacts.generated, false);
    assert.equal(thirdArtifacts.reason, 'disabled');
    assert.equal(listReports(ctx, third.runId).length, 0);
  } finally {
    subject.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test('项目生命周期：重命名、归档、设置、备份、删除与恢复、导入', () => {
  const subject = createTempProject('原始项目名');
  const home = mkdtempSync(join(tmpdir(), 'promptlens-admin-home-'));
  const importRoot = mkdtempSync(join(tmpdir(), 'promptlens-import-'));
  try {
    const ctx = subject.ctx;
    const seed = seedProject(ctx);

    const renamed = renameProject(ctx, '重命名后的项目');
    assert.equal(renamed.name, '重命名后的项目');
    assert.equal(projectSettings(ctx).autoReport, true);

    updateProjectSettings(ctx, { autoReport: false, autoExport: false });
    assert.deepEqual(projectSettings(ctx), { autoReport: false, autoExport: false, sensitiveFields: [] });

    const archived = setProjectArchived(ctx, true);
    assert.ok(archived.archivedAt);
    assert.equal(setProjectArchived(ctx, false).archivedAt, null);

    const backup = backupProject(ctx, { home });
    assert.ok(existsSync(join(backup.path, BACKUP_METADATA_NAME)));
    assert.ok(existsSync(join(backup.path, '.promptlens', 'db', 'project.sqlite3')));
    assert.ok(backup.files >= 2);
    const metadata = JSON.parse(readFileSync(join(backup.path, BACKUP_METADATA_NAME), 'utf8'));
    assert.equal(metadata.projectId, ctx.projectId);
    assert.equal(metadata.schema, 'promptlens.backup/v1');

    // 导入到新目录后资产计数一致
    const importedRoot = join(importRoot, 'imported');
    const imported = importProject({ source: subject.root, destination: importedRoot });
    assert.equal(imported.name, '重命名后的项目');
    assert.equal(imported.counts.cases, 4);
    assert.ok(existsSync(join(importedRoot, '.promptlens', 'db', 'project.sqlite3')));

    // 默认删除进入回收站，可恢复
    ctx.close();
    const trashed = deleteProject({ root: subject.root, home });
    assert.equal(trashed.recoverable, true);
    assert.ok(existsSync(trashed.path));
    assert.equal(listTrash(home).length, 1);
    const restored = restoreTrash(home, trashed.projectId);
    assert.equal(restored.restoredTo, subject.root);
    assert.ok(existsSync(subject.root));
    assert.equal(listTrash(home).length, 0);

    // 永久删除必须确认项目 ID
    assert.throws(() => deleteProject({ root: subject.root, home, permanent: true }), /永久删除/);
    const purged = deleteProject({ root: subject.root, home, permanent: true, confirmProjectId: trashed.projectId });
    assert.equal(purged.permanent, true);
    assert.equal(existsSync(subject.root), false);
  } finally {
    subject.cleanup();
    rmSync(home, { recursive: true, force: true });
    rmSync(importRoot, { recursive: true, force: true });
  }
});

test('运行历史筛选与 P50/P95 延迟统计', async () => {
  const subject = createTempProject('筛选项目');
  try {
    const ctx = subject.ctx;
    const seed = seedProject(ctx);
    const created = createRun(ctx, buildSpec(ctx, seed), { idempotencyKey: 'filter-1' });
    await executeRun(ctx, created.runId);

    const all = listRuns(ctx, { status: 'completed' });
    assert.equal(all.total, 1);
    assert.equal(listRuns(ctx, { status: 'failed' }).total, 0);
    assert.equal(listRuns(ctx, { from: '2999-01-01T00:00:00.000Z' }).total, 0);
    assert.equal(listRuns(ctx, { modelConfigVersionId: seed.modelVersionId }).total, 1);
    assert.equal(listRuns(ctx, { variantVersionId: seed.variantA.versionId }).total, 1);
    assert.equal(listRuns(ctx, { variantVersionId: 'missing' }).total, 0);

    const cost = runCostSummary(ctx, created.runId);
    assert.ok(cost.latency.count >= 4);
    assert.ok(cost.latency.p50Ms !== null && cost.latency.p95Ms !== null);
    assert.ok(cost.latency.p95Ms >= cost.latency.p50Ms);
    assert.ok(cost.requestCount >= 4);
  } finally {
    subject.cleanup();
  }
});

test('按模型组停止只取消该模型的排队 Trial', () => {
  const subject = createTempProject('模型组停止');
  try {
    const ctx = subject.ctx;
    const seed = seedProject(ctx);
    const second = addModel(ctx, {
      name: 'mock-secondary',
      providerType: 'mock',
      modelId: 'mock-small',
      pricing: { currency: 'USD', unit: 'per_request', perRequest: '0.001' },
    });
    const secondVersion = getModelConfigVersion(ctx, second.modelConfigVersionId);
    const spec = buildSpec(ctx, seed, {
      models: [
        { modelConfigVersionId: seed.modelVersionId, modelProfileId: seed.modelProfileId, contentHash: seed.modelHash },
        {
          modelConfigVersionId: second.modelConfigVersionId,
          modelProfileId: secondVersion.profileId,
          contentHash: secondVersion.contentHash,
        },
      ],
    });
    const created = createRun(ctx, spec, { idempotencyKey: 'group-cancel-1' });
    const result = cancelRun(ctx, created.runId, { modelConfigVersionId: seed.modelVersionId });
    assert.equal(result.status, 'queued');
    assert.ok(result.canceledTrials > 0);
    assert.ok(result.remaining > 0);

    const canceled = Number(
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM trials WHERE run_id = ? AND model_config_version_id = ? AND trial_status = 'canceled'")
        .get(created.runId, seed.modelVersionId).n,
    );
    assert.equal(canceled, result.canceledTrials);

    const whole = cancelRun(ctx, created.runId);
    assert.equal(whole.status, 'canceled');
  } finally {
    subject.cleanup();
  }
});

test('AI 生成用例：mock 模型产出候选、预览通过后可提交', async () => {
  const subject = createTempProject('用例生成');
  try {
    const ctx = subject.ctx;
    const seed = seedProject(ctx);
    const generated = await generateCases(ctx, {
      modelConfigVersionId: seed.modelVersionId,
      instruction: '电商客服物流咨询，覆盖催单、丢件、改地址',
      count: 5,
    });
    assert.equal(generated.records.length, 5);
    assert.equal(generated.errors.length, 0);
    assert.equal(generated.generator.requested, 5);
    assert.ok(generated.records.every((record) => record.meta?.generated === true));
    assert.ok(generated.records.every((record) => typeof record.input === 'object'));

    const text = generated.records.map((record) => JSON.stringify(record)).join('\n');
    const preview = createImportPreview(ctx, { text, format: 'jsonl', setName: 'AI 生成集' });
    assert.equal(preview.validRecords, 5);
    assert.equal(preview.errorCount, 0);
    const committed = commitImportPreview(ctx, { previewId: preview.previewId, setName: 'AI 生成集', duplicatePolicy: 'reuse' });
    assert.equal(committed.imported, 5);
    assert.equal(committed.caseCount, 5);
  } finally {
    subject.cleanup();
  }
});

test('AI 生成用例的参数校验与模型响应解析', async () => {
  const subject = createTempProject('用例生成校验');
  try {
    const ctx = subject.ctx;
    const seed = seedProject(ctx);
    await assert.rejects(
      () => generateCases(ctx, { modelConfigVersionId: seed.modelVersionId, instruction: '', count: 3 }),
      /生成说明/,
    );
    await assert.rejects(
      () => generateCases(ctx, { modelConfigVersionId: seed.modelVersionId, instruction: '边界', count: 0 }),
      /1—50/,
    );
    await assert.rejects(
      () => generateCases(ctx, { modelConfigVersionId: 'missing', instruction: '边界', count: 3 }),
      /模型配置/,
    );
    const parsed = parseCandidates('```json\n[{"input":{"question":"a"}}]\n```');
    assert.equal(parsed.length, 1);
  } finally {
    subject.cleanup();
  }
});

test('提示词迭代：基于运行证据生成 diff，并可保存为新分支', async () => {
  const subject = createTempProject('提示词迭代');
  try {
    const ctx = subject.ctx;
    const seed = seedProject(ctx);
    const created = createRun(ctx, buildSpec(ctx, seed), { idempotencyKey: 'iterate-1' });
    await executeRun(ctx, created.runId);

    const preview = await proposePromptIteration(ctx, {
      runId: created.runId,
      modelConfigVersionId: seed.modelVersionId,
      instruction: '减少猜测，信息不足时明确说明',
    });
    assert.equal(preview.runId, created.runId);
    assert.equal(preview.proposal.versionId, null);
    assert.ok(preview.diff.lines.length > 0);
    assert.equal(preview.diff.identical, false);
    assert.ok(preview.evidence.variants.length >= 2);
    assert.ok(preview.evidence.lowScores.length > 0);
    assert.ok(preview.evidence.lowScores[0].input !== null);
    assert.match(preview.proposal.content, /补充要求/);

    const saved = await proposePromptIteration(ctx, {
      runId: created.runId,
      modelConfigVersionId: seed.modelVersionId,
      instruction: '减少猜测，信息不足时明确说明',
      save: true,
      label: 'B-iter',
    });
    assert.ok(saved.proposal.versionId);
    assert.equal(saved.proposal.label, 'B-iter');
    assert.equal(saved.proposal.created, true);
    const version = getPromptVersion(ctx, saved.proposal.versionId);
    assert.match(version.content, /补充要求/);
    assert.equal(version.label, 'B-iter');
  } finally {
    subject.cleanup();
  }
});

test('提示词迭代拒绝未结束或无证据的运行', async () => {
  const subject = createTempProject('提示词迭代校验');
  try {
    const ctx = subject.ctx;
    const seed = seedProject(ctx);
    const pending = createRun(ctx, buildSpec(ctx, seed), { idempotencyKey: 'iterate-pending' });
    await assert.rejects(
      () => proposePromptIteration(ctx, { runId: pending.runId, modelConfigVersionId: seed.modelVersionId, instruction: '' }),
      /尚未结束/,
    );

    ctx.db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(pending.runId);
    await assert.rejects(
      () => proposePromptIteration(ctx, { runId: pending.runId, modelConfigVersionId: seed.modelVersionId, instruction: '' }),
      /没有可比/,
    );
    await assert.rejects(
      () => proposePromptIteration(ctx, { runId: 'missing', modelConfigVersionId: seed.modelVersionId, instruction: '' }),
      /运行不存在/,
    );
  } finally {
    subject.cleanup();
  }
});

test('跨项目用例库：快照独立于源项目，来源与版本可追溯', async () => {
  const source = createTempProject('库源项目');
  const target = createTempProject('库目标项目');
  const home = mkdtempSync(join(tmpdir(), 'promptlens-library-'));
  const sourceRoot = source.root;
  try {
    const seed = seedProject(source.ctx);
    const promoted = promoteTestSet(source.ctx, { testSetVersionId: seed.testSetVersionId, license: 'internal-only', home });
    assert.equal(promoted.version, 1);
    assert.equal(promoted.caseCount, 4);
    assert.equal(promoted.source.projectId, source.ctx.projectId);
    assert.equal(getLibraryEntry(promoted.libraryId, { home }).cases.length, 4);

    // 源项目删除后，已入库快照仍可导入
    source.ctx.close();
    rmSync(sourceRoot, { recursive: true, force: true });
    const imported = importLibraryEntry(target.ctx, { libraryId: promoted.libraryId, home });
    assert.equal(imported.caseCount, 4);
    assert.equal(imported.newVersion, true);
    const origin = testSetOrigin(target.ctx, imported.testSetVersionId);
    assert.equal(origin.libraryId, promoted.libraryId);
    assert.equal(origin.libraryVersion, 1);
    assert.equal(origin.license, 'internal-only');

    // 同名再次提升只增加库版本，不改历史测试集与来源
    const second = promoteTestSet(target.ctx, { testSetVersionId: imported.testSetVersionId, home });
    assert.equal(second.version, 2);
    assert.equal(listLibrary({ home, query: '基础集' }).total, 2);
    assert.equal(testSetOrigin(target.ctx, imported.testSetVersionId).libraryVersion, 1);
    const versions = listTestSets(target.ctx).find((set) => set.name === '基础集').versions;
    assert.ok(versions.some((version) => version.testSetVersionId === imported.testSetVersionId));

    // 导入后的固定版本可直接用于运行
    const targetSeed = seedProject(target.ctx, { setName: '目标基础集' });
    const run = createRun(
      target.ctx,
      buildSpec(target.ctx, targetSeed, {
        testSet: { testSetVersionId: imported.testSetVersionId, contentHash: imported.contentHash },
      }),
      { idempotencyKey: 'library-import-run' },
    );
    await executeRun(target.ctx, run.runId);
    assert.equal(getRun(target.ctx, run.runId).run.status, 'completed');

    // 敏感标记与缺失许可证在复用时可见
    const sensitive = promoteTestSet(target.ctx, {
      testSetVersionId: imported.testSetVersionId,
      setName: '敏感集',
      sensitive: true,
      home,
    });
    const reused = importLibraryEntry(target.ctx, { libraryId: sensitive.libraryId, home });
    assert.ok(reused.warnings.some((warning) => warning.code === 'LIBRARY_SENSITIVE_SOURCE'));
    assert.ok(reused.warnings.some((warning) => warning.code === 'LIBRARY_LICENSE_MISSING'));
  } finally {
    target.cleanup();
    rmSync(home, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test('不存在项目路径时给出可读错误', () => {
  const home = mkdtempSync(join(tmpdir(), 'promptlens-admin-empty-'));
  try {
    assert.throws(() => deleteProject({ root: join(home, 'missing'), home }), /未找到项目清单/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
