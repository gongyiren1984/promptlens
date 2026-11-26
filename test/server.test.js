import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startServer } from '../src/server/http.js';
import { createTempProject, seedProject, buildSpec } from './helpers.js';

async function withServer(fn) {
  const home = mkdtempSync(join(tmpdir(), 'promptlens-api-home-'));
  const subject = createTempProject('API 测试项目');
  let handle;
  try {
    handle = await startServer({
      workspace: dirname(subject.root),
      home,
      tokenFile: join(home, 'token'),
      origins: ['http://localhost:5173'],
    });
    const call = async (method, path, body) => {
      const res = await fetch(`${handle.endpoint}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${handle.token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, envelope: await res.json() };
    };
    await fn({ handle, call, project: subject, home });
  } finally {
    if (handle) await handle.close();
    subject.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
}

test('HTTP：健康检查与令牌/Origin 校验', async () => {
  await withServer(async ({ handle, call }) => {
    const health = await fetch(`${handle.endpoint}/v1/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.apiVersion, 'v1');

    const noToken = await fetch(`${handle.endpoint}/v1/projects`);
    assert.equal(noToken.status, 401);
    assert.equal((await noToken.json()).error.code, 'AUTH_UNAUTHORIZED');

    const badOrigin = await fetch(`${handle.endpoint}/v1/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(badOrigin.status, 403);

    const caps = await call('GET', '/v1/capabilities');
    assert.equal(caps.status, 200);
    assert.equal(caps.envelope.data.apiVersion, 'v1');
    assert.ok(caps.envelope.data.routes.includes('POST /v1/projects/:projectId/runs'));
    assert.ok(caps.envelope.data.errorCodes.some((entry) => entry.code === 'NOT_FOUND_DRAFT'));
  });
});

test('HTTP：项目发现、概览与健康检查', async () => {
  await withServer(async ({ call, project }) => {
    const list = await call('GET', '/v1/projects');
    assert.equal(list.status, 200);
    const found = list.envelope.data.projects.find((item) => item.projectId === project.ctx.projectId);
    assert.ok(found, '工作区应发现临时项目');

    const overview = await call('GET', `/v1/projects/${project.ctx.projectId}/overview`);
    assert.equal(overview.status, 200);
    assert.equal(overview.envelope.data.summary.projectId, project.ctx.projectId);
    assert.equal(overview.envelope.data.health.status, 'ok');

    const missing = await call('GET', '/v1/projects/does-not-exist/health');
    assert.equal(missing.status, 404);
    assert.equal(missing.envelope.error.code, 'NOT_FOUND_PROJECT');
  });
});

test('HTTP：提示词创建、版本与差异', async () => {
  await withServer(async ({ call, project }) => {
    const pid = project.ctx.projectId;
    const created = await call('POST', `/v1/projects/${pid}/prompts`, {
      name: '摘要提示词',
      label: 'A',
      content: '请总结：{{text}}',
    });
    assert.equal(created.status, 200);
    const variantA = created.envelope.data.variant;

    const second = await call('POST', `/v1/projects/${pid}/prompts`, {
      name: '摘要提示词',
      label: 'B',
      content: '请用一句话总结：{{text}}',
    });
    assert.equal(second.status, 200);
    const variantB = second.envelope.data.variant;

    const list = await call('GET', `/v1/projects/${pid}/prompts`);
    const prompt = list.envelope.data.prompts.find((item) => item.name === '摘要提示词');
    assert.equal(prompt.variants.length, 2);

    const diff = await call('GET', `/v1/projects/${pid}/prompt-diff?left=${variantA.versionId}&right=${variantB.versionId}`);
    assert.equal(diff.status, 200);
    assert.equal(diff.envelope.data.identical, false);
    assert.ok(diff.envelope.data.lines.length > 0);

    const version = await call('GET', `/v1/projects/${pid}/prompt-versions/${variantA.versionId}`);
    assert.deepEqual(version.envelope.data.variables, ['text']);

    const changedA = await call('POST', `/v1/projects/${pid}/prompts/${prompt.promptId}/variants`, {
      label: 'A',
      content: '请精炼总结：{{text}}',
    });
    assert.equal(changedA.envelope.data.versionNumber, 2);
    const restored = await call('POST', `/v1/projects/${pid}/prompt-versions/${variantA.versionId}/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.envelope.data.created, true);
    assert.equal(restored.envelope.data.versionNumber, 3);
    const restoredDetail = await call('GET', `/v1/projects/${pid}/prompt-versions/${restored.envelope.data.versionId}`);
    assert.equal(restoredDetail.envelope.data.content, '请总结：{{text}}');
  });
});

test('HTTP：用例导入预览与原子提交', async () => {
  await withServer(async ({ call, project }) => {
    const pid = project.ctx.projectId;
    const csv = 'input,expected_json,meta_json\n你好,,"{""outputFormat"":""text""}"\n再见,,\n';
    const preview = await call('POST', `/v1/projects/${pid}/cases/import/preview`, {
      text: csv,
      format: 'csv',
      setName: '接口集',
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.envelope.data.validRecords, 2);
    assert.equal(preview.envelope.data.errorCount, 0);
    assert.equal(preview.envelope.data.columns.includes('input'), true);

    const commit = await call('POST', `/v1/projects/${pid}/cases/import/commit`, {
      previewId: preview.envelope.data.previewId,
      setName: '接口集',
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.envelope.data.caseCount, 2);
    assert.equal(commit.envelope.data.newVersion, true);

    const reused = await call('POST', `/v1/projects/${pid}/cases/import/commit`, {
      previewId: 'missing-preview',
    });
    assert.equal(reused.status, 404);
    assert.equal(reused.envelope.error.code, 'NOT_FOUND_PREVIEW');

    const invalid = await call('POST', `/v1/projects/${pid}/cases/import/preview`, {
      text: 'a,b\n1,2\n',
      format: 'csv',
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.envelope.error.code, 'VALIDATION_INVALID_REQUEST');
  });
});

test('HTTP：实验草稿 CRUD', async () => {
  await withServer(async ({ call, project }) => {
    const pid = project.ctx.projectId;
    const created = await call('POST', `/v1/projects/${pid}/drafts`, {
      name: '草稿一',
      step: 2,
      payload: { branches: ['A'] },
    });
    assert.equal(created.status, 200);
    const draftId = created.envelope.data.draftId;

    const patched = await call('PATCH', `/v1/projects/${pid}/drafts/${draftId}`, { step: 3, payload: { branches: ['A', 'B'] } });
    assert.equal(patched.envelope.data.step, 3);
    assert.deepEqual(patched.envelope.data.payload.branches, ['A', 'B']);

    const list = await call('GET', `/v1/projects/${pid}/drafts`);
    assert.equal(list.envelope.data.drafts.length, 1);

    const removed = await call('DELETE', `/v1/projects/${pid}/drafts/${draftId}`);
    assert.equal(removed.envelope.data.deleted, true);
    const missing = await call('DELETE', `/v1/projects/${pid}/drafts/${draftId}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.envelope.error.code, 'NOT_FOUND_DRAFT');
  });
});

test('HTTP：项目生命周期、备份、回收站与自动报告设置', async () => {
  await withServer(async ({ call, project, home }) => {
    const pid = project.manifest.projectId;

    const settings = await call('GET', `/v1/projects/${pid}/settings`);
    assert.equal(settings.status, 200);
    assert.equal(settings.envelope.data.settings.autoReport, true);

    const patched = await call('PATCH', `/v1/projects/${pid}/settings`, { autoExport: false });
    assert.equal(patched.envelope.data.settings.autoExport, false);

    const renamed = await call('POST', `/v1/projects/${pid}/rename`, { name: 'API 重命名项目' });
    assert.equal(renamed.envelope.data.name, 'API 重命名项目');

    const archived = await call('POST', `/v1/projects/${pid}/archive`, { archived: true });
    assert.ok(archived.envelope.data.archivedAt);

    const backup = await call('POST', `/v1/projects/${pid}/backup`, {});
    assert.equal(backup.status, 200);
    assert.ok(existsSync(backup.envelope.data.path));
    const httpActor = project.ctx.db.prepare("SELECT actor FROM audit_events WHERE type = 'project.backed_up' ORDER BY created_at DESC LIMIT 1").get();
    assert.equal(httpActor?.actor, 'http');

    const recovery = await call('POST', `/v1/projects/${pid}/recovery`, {});
    assert.equal(recovery.status, 200);
    assert.equal(recovery.envelope.data.readonly, true);
    assert.ok(existsSync(recovery.envelope.data.manifestPath));
    const recoveryManifest = JSON.parse(readFileSync(recovery.envelope.data.manifestPath, 'utf8'));
    assert.equal(recoveryManifest.schema, 'promptlens.recovery/v1');
    assert.equal(recoveryManifest.databaseStatus, 'readable');
    assert.equal(typeof recoveryManifest.objects.counts.prompts, 'number');

    const recoveries = await call('GET', '/v1/recovery');
    assert.ok(recoveries.envelope.data.copies.some((copy) => copy.projectId === pid));

    const located = await call('POST', '/v1/projects/locate', { projectId: pid });
    assert.equal(located.status, 200);
    assert.equal(located.envelope.data.projectId, pid);
    assert.ok(existsSync(join(located.envelope.data.root, 'promptlens.project.yaml')));

    const inline = await call('POST', `/v1/projects/${pid}/runs`, {
      spec: buildSpec(project.ctx, seedProject(project.ctx)),
      inline: true,
      idempotencyKey: 'api-auto-report',
    });
    assert.equal(inline.status, 200);
    assert.equal(inline.envelope.data.artifacts.generated, true);
    assert.equal(inline.envelope.data.artifacts.exported, false, 'autoExport=false 时只保留预览版本');

    const filtered = await call('GET', `/v1/projects/${pid}/runs?status=completed&from=2020-01-01&to=2999-12-31`);
    assert.equal(filtered.status, 200);
    assert.ok(filtered.envelope.data.total >= 1);

    const removed = await call('POST', `/v1/projects/${pid}/delete`, {});
    assert.equal(removed.status, 200);
    assert.equal(removed.envelope.data.recoverable, true);

    const trash = await call('GET', '/v1/trash');
    assert.ok(trash.envelope.data.entries.length >= 1);

    const restored = await call('POST', `/v1/trash/${pid}/restore`, {});
    assert.equal(restored.status, 200);
    assert.equal(restored.envelope.data.project.projectId, pid);
    assert.ok(existsSync(join(project.root, 'promptlens.project.yaml')));

    const imported = await call('POST', '/v1/projects/import', {
      source: project.root,
      destination: join(home, 'imported-project'),
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.envelope.data.counts.cases, 4);
  });
});

test('HTTP：AI 生成用例返回预览并可直接提交', async () => {
  await withServer(async ({ call, project }) => {
    const pid = project.ctx.projectId;
    const seed = seedProject(project.ctx);
    const generated = await call('POST', `/v1/projects/${pid}/cases/generate`, {
      modelConfigVersionId: seed.modelVersionId,
      instruction: '电商客服物流咨询，覆盖催单、丢件与改地址',
      count: 3,
      setName: 'AI 生成集',
    });
    assert.equal(generated.status, 200);
    assert.equal(generated.envelope.data.records.length, 3);
    assert.equal(generated.envelope.data.preview.validRecords, 3);

    const committed = await call('POST', `/v1/projects/${pid}/cases/import/commit`, {
      previewId: generated.envelope.data.preview.previewId,
      setName: 'AI 生成集',
      duplicatePolicy: 'reuse',
    });
    assert.equal(committed.status, 200);
    assert.equal(committed.envelope.data.imported, 3);
  });
});

test('HTTP：提示词迭代返回 diff 并可保存新分支', async () => {
  await withServer(async ({ call, project }) => {
    const pid = project.ctx.projectId;
    const seed = seedProject(project.ctx);
    const run = await call('POST', `/v1/projects/${pid}/runs`, {
      spec: buildSpec(project.ctx, seed),
      inline: true,
      idempotencyKey: 'api-iteration',
    });
    const runId = run.envelope.data.runId;
    const iteration = await call('POST', `/v1/projects/${pid}/runs/${runId}/prompt-iteration`, {
      modelConfigVersionId: seed.modelVersionId,
      instruction: '减少猜测',
    });
    assert.equal(iteration.status, 200);
    assert.ok(iteration.envelope.data.diff.lines.length > 0);
    assert.equal(iteration.envelope.data.proposal.versionId, null);

    const saved = await call('POST', `/v1/projects/${pid}/prompts/${iteration.envelope.data.base.promptId}/variants`, {
      label: 'B-api-iter',
      content: iteration.envelope.data.proposal.content,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.envelope.data.label, 'B-api-iter');
    assert.equal(saved.envelope.data.created, true);
  });
});

test('HTTP：优化建议预览、生成、列表与状态更新', async () => {
  await withServer(async ({ call, project }) => {
    const pid = project.ctx.projectId;
    const seed = seedProject(project.ctx);
    const run = await call('POST', `/v1/projects/${pid}/runs`, {
      spec: buildSpec(project.ctx, seed),
      inline: true,
      idempotencyKey: 'api-suggestions',
    });
    const runId = run.envelope.data.runId;

    const context = await call('GET', `/v1/projects/${pid}/runs/${runId}/prompt-suggestions/context?modelConfigVersionId=${seed.modelVersionId}&maxSuggestions=3`);
    assert.equal(context.status, 200);
    assert.equal(context.envelope.data.evidenceCount, 4);
    assert.equal(context.envelope.data.cost.amount, '0.001');
    assert.ok(context.envelope.data.lowDimensions.length > 0);

    const created = await call('POST', `/v1/projects/${pid}/runs/${runId}/prompt-suggestions`, {
      modelConfigVersionId: seed.modelVersionId,
      focus: '边界处理',
      maxSuggestions: 3,
    });
    assert.equal(created.status, 200);
    assert.equal(created.envelope.data.promptUnchanged, true);
    assert.equal(created.envelope.data.status, 'generated');
    assert.ok(created.envelope.data.suggestions.length > 0);
    const suggestionId = created.envelope.data.suggestionId;

    const list = await call('GET', `/v1/projects/${pid}/runs/${runId}/prompt-suggestions`);
    assert.equal(list.envelope.data.suggestions.length, 1);

    const accepted = await call('PATCH', `/v1/projects/${pid}/prompt-suggestions/${suggestionId}`, { status: 'accepted' });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.envelope.data.status, 'accepted');

    const projectList = await call('GET', `/v1/projects/${pid}/prompt-suggestions?status=accepted`);
    assert.equal(projectList.envelope.data.suggestions.length, 1);
    const detail = await call('GET', `/v1/projects/${pid}/prompt-suggestions/${suggestionId}`);
    assert.equal(detail.envelope.data.status, 'accepted');
    assert.equal(detail.envelope.data.suggestions.length, created.envelope.data.suggestions.length);
  });
});

test('HTTP：预检、运行、事件、报告与成本', async () => {
  await withServer(async ({ handle, call, project }) => {
    const seed = seedProject(project.ctx);
    const spec = buildSpec(project.ctx, seed);
    const pid = project.ctx.projectId;

    const preflight = await call('POST', `/v1/projects/${pid}/runs/preflight`, { spec, includeSnapshot: true });
    assert.equal(preflight.status, 200);
    assert.ok(preflight.envelope.data.trialCount >= 4);
    assert.ok(preflight.envelope.data.snapshotHash.startsWith('sha256:'));

    const started = await call('POST', `/v1/projects/${pid}/runs`, { spec, inline: true, idempotencyKey: 'api-test-001' });
    assert.equal(started.status, 200);
    const runId = started.envelope.data.runId;
    assert.ok(['completed', 'completed_with_errors'].includes(started.envelope.data.status));

    const detail = await call('GET', `/v1/projects/${pid}/runs/${runId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.envelope.data.counts.total, preflight.envelope.data.trialCount);
    assert.ok(detail.envelope.data.labels.variants[Object.keys(detail.envelope.data.labels.variants)[0]].label);

    const evaluations = await call('GET', `/v1/projects/${pid}/runs/${runId}/evaluations`);
    assert.equal(evaluations.status, 200);
    assert.ok(evaluations.envelope.data.total > 0);

    const cost = await call('GET', `/v1/projects/${pid}/runs/${runId}/cost`);
    assert.equal(cost.status, 200);
    assert.equal(cost.envelope.data.complete, true);

    // 幂等复用
    const again = await call('POST', `/v1/projects/${pid}/runs`, { spec, inline: true, idempotencyKey: 'api-test-001' });
    assert.equal(again.envelope.data.reused, true);
    assert.equal(again.envelope.data.runId, runId);

    // 同键不同规格
    const conflict = await call('POST', `/v1/projects/${pid}/runs`, {
      spec: { ...spec, repetitions: 2 },
      inline: true,
      idempotencyKey: 'api-test-001',
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.envelope.error.code, 'STATE_IDEMPOTENCY_CONFLICT');

    const report = await call('POST', `/v1/projects/${pid}/reports`, { runId });
    assert.equal(report.status, 200);
    assert.ok(report.envelope.data.contentHash.startsWith('sha256:'));
    const reportDetail = await call('GET', `/v1/projects/${pid}/reports/${report.envelope.data.reportId}`);
    assert.equal(reportDetail.status, 200);
    for (const heading of ['运行摘要', '实验快照', '评估方法', '分维度结果', '逐用例证据', '失败与无效输出', '成本与耗时', '不确定性', '限制与建议']) {
      assert.ok(reportDetail.envelope.data.markdown.includes(heading), `报告应包含章节 ${heading}`);
    }

    const runs = await call('GET', `/v1/projects/${pid}/runs?limit=5`);
    assert.equal(runs.envelope.data.runs[0].runId, runId);
    assert.equal(runs.envelope.data.runs[0].counts.total, preflight.envelope.data.trialCount);

    // SSE：已结束的运行应立即补齐事件并以 end 收尾
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const stream = await fetch(`${handle.endpoint}/v1/projects/${pid}/runs/${runId}/events?afterSeq=0`, {
      headers: { Authorization: `Bearer ${handle.token}` },
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    let text = '';
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes('event: end')) break;
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
    assert.ok(text.includes('run_created'));
    assert.ok(text.includes('run_finished'));
    assert.ok(text.includes('event: end'));
  });
});

test('HTTP：用例库提升、列表、详情与导入', async () => {
  await withServer(async ({ call, project }) => {
    const seed = seedProject(project.ctx);
    const pid = project.ctx.projectId;

    const promoted = await call('POST', `/v1/projects/${pid}/testsets/${seed.testSetVersionId}/promote`, {
      license: 'internal-only',
      sensitive: true,
    });
    assert.equal(promoted.status, 200);
    const entry = promoted.envelope.data;
    assert.equal(entry.version, 1);
    assert.equal(entry.sensitive, true);

    const list = await call('GET', '/v1/library');
    assert.equal(list.status, 200);
    assert.ok(list.envelope.data.entries.some((item) => item.libraryId === entry.libraryId));

    const detail = await call('GET', `/v1/library/${entry.libraryId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.envelope.data.cases.length, 4);

    const imported = await call('POST', `/v1/projects/${pid}/library/${entry.libraryId}/import`, { setName: '复用集' });
    assert.equal(imported.status, 200);
    assert.equal(imported.envelope.data.caseCount, 4);
    assert.ok(imported.envelope.warnings.some((warning) => warning.code === 'LIBRARY_SENSITIVE_SOURCE'));

    const sets = await call('GET', `/v1/projects/${pid}/testsets`);
    const reuse = sets.envelope.data.testSets.find((set) => set.name === '复用集');
    assert.equal(reuse.versions[0].origin.libraryId, entry.libraryId);
    assert.equal(reuse.versions[0].origin.license, 'internal-only');

    const missing = await call('GET', '/v1/library/not-a-real-entry');
    assert.equal(missing.status, 404);
    assert.equal(missing.envelope.error.code, 'NOT_FOUND_LIBRARY');
  });
});

test('HTTP：应用配置默认值与运行时切换工作区', async () => {
  await withServer(async ({ call, handle }) => {
    const initial = await call('GET', '/v1/app/config');
    assert.equal(initial.status, 200);
    assert.equal(initial.envelope.data.schema, 'promptlens.app-config/v1');
    assert.equal(initial.envelope.data.workspaceRoot, null);
    assert.equal(initial.envelope.data.onboarding.completedAt, null);
    assert.equal(initial.envelope.data.onboarding.skipped, false);

    const nextWorkspace = join(handle.registry.home, 'workspace-next');
    const patched = await call('PATCH', '/v1/app/config', { workspaceRoot: nextWorkspace });
    assert.equal(patched.status, 200);
    assert.equal(patched.envelope.data.workspaceRoot, nextWorkspace);

    const caps = await call('GET', '/v1/capabilities');
    assert.equal(caps.envelope.data.workspace, nextWorkspace);
    const projects = await call('GET', '/v1/projects');
    assert.equal(projects.envelope.data.root, nextWorkspace);

    const relative = await call('PATCH', '/v1/app/config', { workspaceRoot: 'relative/path' });
    assert.equal(relative.status, 400);
    assert.equal(relative.envelope.error.code, 'VALIDATION_INVALID_REQUEST');

    const onboarded = await call('PATCH', '/v1/app/config', {
      onboarding: { completedAt: '2026-01-01T00:00:00.000Z', version: 1, skipped: true },
    });
    assert.equal(onboarded.envelope.data.onboarding.skipped, true);
    assert.equal(onboarded.envelope.data.onboarding.completedAt, '2026-01-01T00:00:00.000Z');
  });
});

test('HTTP：MCP 接入信息包含启动命令与工具清单', async () => {  await withServer(async ({ call, project }) => {
    const pid = project.ctx.projectId;
    const info = await call('GET', `/v1/projects/${pid}/mcp-info?scopes=project:read`);
    assert.equal(info.status, 200);
    assert.deepEqual(info.envelope.data.transports, ['stdio']);
    assert.ok(info.envelope.data.toolCount > 0);
    assert.ok(info.envelope.data.tools.includes('promptlens_project_get'));
    assert.equal(info.envelope.data.projectRoot, project.root);
    assert.deepEqual(info.envelope.data.scopes.default, ['project:read', 'run:read']);
    const server = info.envelope.data.clientConfig.mcpServers.promptlens;
    assert.ok(server.args.includes('mcp'));
    assert.ok(server.args.includes('--project'));
    assert.ok(server.args.includes(project.root));
    assert.ok(server.args.includes('project:read'));
  });
});

test('HTTP：跨项目模型库保存、导入与移除', async () => {
  await withServer(async ({ call, project }) => {
    const pid = project.ctx.projectId;
    const saved = await call('POST', '/v1/model-library', {
      name: 'shared-mock',
      providerType: 'mock',
      modelId: 'mock-large',
      params: { temperature: 0 },
      pricing: { currency: 'USD', unit: 'per_million_tokens', input: '0.1', output: '0.2' },
    });
    assert.equal(saved.status, 200);
    const libraryId = saved.envelope.data.id;
    assert.ok(libraryId);

    const list = await call('GET', '/v1/model-library');
    assert.equal(list.status, 200);
    assert.equal(list.envelope.data.entries.length, 1);
    assert.equal(list.envelope.data.entries[0].name, 'shared-mock');

    const imported = await call('POST', `/v1/projects/${pid}/models/from-library`, { libraryId });
    assert.equal(imported.status, 200);
    assert.equal(imported.envelope.data.name, 'shared-mock');
    const models = await call('GET', `/v1/projects/${pid}/models`);
    assert.ok(models.envelope.data.models.some((model) => model.name === 'shared-mock'));

    const removed = await call('DELETE', `/v1/model-library/${libraryId}`);
    assert.equal(removed.status, 200);
    const missing = await call('POST', `/v1/projects/${pid}/models/from-library`, { libraryId: 'not-a-real-entry' });
    assert.equal(missing.status, 404);
    assert.equal(missing.envelope.error.code, 'NOT_FOUND_MODEL');
  });
});
