import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, hashJson, hashText, normalizeText } from '../src/core/hash.js';
import { ulid } from '../src/core/ids.js';
import { parseYaml, stringifyYaml } from '../src/core/yaml.js';
import { diffLines } from '../src/core/assets.js';
import { parseCsv, parseCasesText } from '../src/core/cases.js';
import { evaluateRules } from '../src/eval/rules.js';
import { computeUsageCost, formatAmount } from '../src/core/models.js';
import { success, failure, exitCodeForEnvelope } from '../src/core/envelope.js';
import { PromptLensError, resolveExitCode, catalogSummary } from '../src/core/errors.js';
import { parseJudgeResponse } from '../src/eval/judge.js';
import { credentialAccount, storeKeychainCredential } from '../src/core/credentials.js';
import { readModelLibrary, saveModelLibraryEntry, deleteModelLibraryEntry } from '../src/core/model-library.js';
import { mcpInfo } from '../src/mcp/info.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAiCompatibleGenerate } from '../src/providers/openai.js';
import { computeBackoffMs } from '../src/core/run.js';
import { redactMarkdown } from '../src/core/report.js';

test('canonicalJson 排序稳定且忽略 undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});

test('hashText 统一换行并去除 BOM', () => {
  assert.equal(hashText('\uFEFFa\r\nb'), hashText('a\nb'));
  assert.match(hashText('x'), /^sha256:[a-f0-9]{64}$/);
});

test('ulid 满足 id 字符集且单调', () => {
  const ids = Array.from({ length: 1000 }, () => ulid());
  ids.forEach((id) => assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/));
  assert.equal(new Set(ids).size, ids.length);
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1]);
});

test('YAML 子集解析：映射、序列、行内 JSON、标量', () => {
  const parsed = parseYaml(`
schema: promptlens.project/v1
projectId: 01ABC
name: "含 # 的名称"
nested:
  enabled: true
  count: 3
  ratio: 0.5
list:
  - run
  - report
items:
  - id: a
    value: 1
  - id: b
    value: 2
inline: {"maxAttempts": 3, "order": "sequential"}
empty: null
`);
  assert.equal(parsed.schema, 'promptlens.project/v1');
  assert.equal(parsed.name, '含 # 的名称');
  assert.equal(parsed.nested.enabled, true);
  assert.equal(parsed.nested.ratio, 0.5);
  assert.deepEqual(parsed.list, ['run', 'report']);
  assert.deepEqual(parsed.items, [{ id: 'a', value: 1 }, { id: 'b', value: 2 }]);
  assert.deepEqual(parsed.inline, { maxAttempts: 3, order: 'sequential' });
  assert.equal(parsed.empty, null);
  assert.deepEqual(parseYaml(stringifyYaml(parsed)), parsed);
});

test('diffLines 标记新增、删除与上下文', () => {
  const lines = diffLines('a\nb\nc', 'a\nx\nc');
  assert.deepEqual(lines.map((line) => line.type), ['equal', 'remove', 'add', 'equal']);
});

test('CSV 解析支持引号、逗号与换行', () => {
  const rows = parseCsv('input,meta_json\n"你好, 世界","{""k"":1}"\n第二行\n');
  assert.deepEqual(rows[0], ['input', 'meta_json']);
  assert.equal(rows[1][0], '你好, 世界');
  assert.equal(rows[1][1], '{"k":1}');
});

test('用例导入支持 JSONL 与非法行整体报错', () => {
  const records = parseCasesText('{"input":{"q":"1"}}\n{"input":{"q":"2"}}\n', 'jsonl');
  assert.equal(records.length, 2);
  assert.throws(() => parseCasesText('{"input":1}\nnot-json\n', 'jsonl'), (error) => error.code === 'VALIDATION_INVALID_REQUEST');
});

test('规则评估覆盖全部类型', () => {
  const result = evaluateRules(
    [
      { type: 'contains', value: '订单' },
      { type: 'not_contains', value: '不知道' },
      { type: 'regex', value: '\\d+ 天' },
      { type: 'min_length', value: 4 },
      { type: 'max_length', value: 100 },
      { type: 'json_valid', required: ['answer'] },
      { type: 'equals', expected: true },
    ],
    { content: '{"answer":"订单 3 天内送达"}', expected: '{"answer":"订单 3 天内送达"}' },
  );
  assert.equal(result.total, 7);
  assert.equal(result.passed, 7);
  assert.equal(result.score, 1);
});

test('computeUsageCost 未知价格返回 unknown 而非 0', () => {
  const usage = { inputTokens: 1000, outputTokens: 500 };
  assert.deepEqual(computeUsageCost(usage, null), { amount: null, currency: null, billingState: 'unknown' });
  const perMillion = computeUsageCost(usage, { currency: 'USD', unit: 'per_million_tokens', input: '1', output: '2' });
  assert.equal(perMillion.amount, '0.002');
  assert.equal(perMillion.billingState, 'known');
  assert.equal(formatAmount(0.0001), '0.0001');
});

test('envelope 与退出码契约', () => {
  const ok = success({ x: 1 });
  assert.equal(ok.apiVersion, 'v1');
  assert.equal(ok.ok, true);
  assert.equal(ok.error, null);
  assert.equal(exitCodeForEnvelope(ok), 0);

  const cases = [
    ['VALIDATION_INVALID_REQUEST', 3],
    ['NOT_FOUND_PROJECT', 5],
    ['STATE_IDEMPOTENCY_CONFLICT', 6],
    ['BUDGET_EXCEEDED', 7],
    ['AUTH_CREDENTIAL_UNAVAILABLE', 4],
    ['PROVIDER_RATE_LIMITED', 10],
    ['PROVIDER_AUTH_FAILED', 11],
    ['STORAGE_OBJECT_MISSING', 11],
    ['INTERNAL_UNEXPECTED', 11],
  ];
  for (const [code, expected] of cases) {
    const env = failure(new PromptLensError(code));
    assert.equal(env.ok, false);
    assert.equal(exitCodeForEnvelope(env), expected, code);
    assert.equal(resolveExitCode(code, true), expected, code);
  }
  const timeout = failure(new PromptLensError('INTEGRATION_CLI_TIMEOUT'));
  assert.equal(exitCodeForEnvelope(timeout), 124);
});

test('错误码目录全部可解析退出码', () => {
  const codes = catalogSummary();
  assert.ok(codes.length >= 30);
  for (const entry of codes) assert.ok([3, 4, 5, 6, 7, 10, 11, 124].includes(entry.exitCode), entry.code);
});

test('评审响应解析容忍代码围栏与越界分数', () => {
  const parsed = parseJudgeResponse('```json\n{"scores":{"accuracy":1.4,"empathy":-0.2}}\n```');
  assert.equal(parsed.scores.accuracy, 1);
  assert.equal(parsed.scores.empathy, 0);
  assert.throws(() => parseJudgeResponse('not json'), (error) => error.code === 'PROVIDER_INVALID_REQUEST');
});

test('normalizeText 保留正文尾随空白', () => {
  assert.equal(normalizeText('a  \n'), 'a  \n');
  assert.equal(hashJson({ a: 1 }), hashJson({ a: 1 }));
});

test('OpenAI 兼容适配器：成功映射、限流分类与凭据缺失', async () => {
  process.env.PROMPTLENS_TEST_KEY = 'test-key';
  const baseConfig = {
    modelId: 'test-model',
    baseUrl: 'https://example.invalid/v1',
    credentialRef: 'env:PROMPTLENS_TEST_KEY',
    params: {},
  };
  const okFetch = async () =>
    new Response(
      JSON.stringify({
        model: 'test-model',
        choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const ok = await openAiCompatibleGenerate({ modelConfig: baseConfig, messages: [], fetchImpl: okFetch });
  assert.equal(ok.content, 'pong');
  assert.equal(ok.finishReason, 'stop');
  assert.equal(ok.usage.inputTokens, 12);
  assert.equal(ok.usage.outputTokens, 3);

  const limitedFetch = async () => new Response('{"error":"rate"}', { status: 429, headers: { 'retry-after': '2' } });
  await assert.rejects(
    () => openAiCompatibleGenerate({ modelConfig: baseConfig, messages: [], fetchImpl: limitedFetch }),
    (error) => error.code === 'PROVIDER_RATE_LIMITED' && error.retryable === true && error.details.retryAfterMs === 2000,
  );

  const authFetch = async () => new Response('{}', { status: 401 });
  await assert.rejects(
    () => openAiCompatibleGenerate({ modelConfig: baseConfig, messages: [], fetchImpl: authFetch }),
    (error) => error.code === 'PROVIDER_AUTH_FAILED' && error.retryable === false,
  );

  await assert.rejects(
    () => openAiCompatibleGenerate({ modelConfig: { ...baseConfig, credentialRef: 'env:PROMPTLENS_MISSING_KEY' }, messages: [] }),
    (error) => error.code === 'AUTH_CREDENTIAL_UNAVAILABLE',
  );
});

test('重试退避加入随机抖动并遵守上下界', () => {
  const atMin = computeBackoffMs({ baseMs: 100, maxMs: 10_000, attempt: 1, random: () => 0 });
  const atMax = computeBackoffMs({ baseMs: 100, maxMs: 10_000, attempt: 1, random: () => 1 });
  assert.equal(atMin, 80, '±20% 抖动下界');
  assert.equal(atMax, 120, '±20% 抖动上界');
  const mid = computeBackoffMs({ baseMs: 100, maxMs: 10_000, attempt: 1, random: () => 0.5 });
  assert.equal(mid, 100, '随机中值不改变基准');
  assert.equal(computeBackoffMs({ baseMs: 100, maxMs: 10_000, attempt: 3, random: () => 0.5 }), 400, '第 3 次指数退避');
  assert.equal(computeBackoffMs({ baseMs: 100, maxMs: 150, attempt: 5, random: () => 0.5 }), 150, '不超过 maxBackoffMs');
  assert.equal(computeBackoffMs({ baseMs: 100, maxMs: 10_000, attempt: 1, retryAfterMs: 2000, random: () => 0 }), 2000, '服务端 retryAfter 优先');
});

test('报告脱敏替换鉴权头、密钥与用户配置的敏感字段', () => {
  const input = [
    'Authorization: Bearer abc.def.ghi',
    'api_key=sk-1234567890abcdef',
    '客户手机 13800000000',
    '常规文本保留',
  ].join('\n');
  const { text, applied } = redactMarkdown(input, ['regex:1\\d{10}', '常规文本']);
  assert.ok(!text.includes('abc.def.ghi'));
  assert.ok(!text.includes('sk-1234567890abcdef'));
  assert.ok(!text.includes('13800000000'));
  assert.ok(!text.includes('常规文本'));
  assert.ok(text.includes('保留'));
  assert.ok(applied.includes('authorization'));
  assert.ok(applied.includes('api_key'));
  assert.ok(applied.includes('credentialRef'));
  assert.ok(applied.some((entry) => entry.startsWith('regex:')));
  assert.ok(applied.includes('field:常规文本'));
});

test('凭据：API Key 写入钥匙串只返回引用', () => {
  const calls = [];
  const result = storeKeychainCredential(
    { key: '  sk-secret-value  ', account: 'GPT-4o Mini' },
    { platform: 'darwin', run: (bin, args) => calls.push([bin, args]) },
  );
  assert.equal(result.credentialRef, 'keychain:promptlens:gpt-4o-mini');
  assert.doesNotMatch(JSON.stringify(result), /sk-secret-value/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'security');
  assert.deepEqual(calls[0][1].slice(0, 6), ['add-generic-password', '-U', '-s', 'promptlens', '-a', 'gpt-4o-mini']);
  assert.equal(calls[0][1][7], 'sk-secret-value');
});

test('凭据：非法输入与不支持平台被拒绝', () => {
  assert.throws(() => storeKeychainCredential({ key: '' }, { platform: 'darwin', run: () => {} }), /不能为空/);
  assert.throws(() => storeKeychainCredential({ key: 'sk-abc def' }, { platform: 'darwin', run: () => {} }), /空白字符/);
  assert.throws(() => storeKeychainCredential({ key: 'sk-abc' }, { platform: 'linux', run: () => {} }), /系统钥匙串/);
  assert.equal(credentialAccount('  中文 名称  '), 'default');
  assert.equal(credentialAccount('My Model'), 'my-model');
});

test('模型库：跨项目保存、同名更新与删除', () => {
  const home = mkdtempSync(join(tmpdir(), 'promptlens-home-'));
  try {
    const saved = saveModelLibraryEntry(home, {
      name: 'GPT-4o',
      providerType: 'openai_compatible',
      modelId: 'gpt-4o',
      baseUrl: 'https://api.example.com/v1',
      credentialRef: 'env:OPENAI_API_KEY',
    });
    assert.ok(saved.id);
    assert.equal(saved.credentialRef, 'env:OPENAI_API_KEY');
    assert.equal(readModelLibrary(home).entries.length, 1);

    const updated = saveModelLibraryEntry(home, {
      name: 'GPT-4o',
      providerType: 'openai_compatible',
      modelId: 'gpt-4o-mini',
      baseUrl: 'https://api.example.com/v1',
    });
    assert.equal(updated.id, saved.id);
    assert.equal(readModelLibrary(home).entries.length, 1);
    assert.equal(readModelLibrary(home).entries[0].modelId, 'gpt-4o-mini');

    deleteModelLibraryEntry(home, saved.id);
    assert.equal(readModelLibrary(home).entries.length, 0);
    assert.throws(() => deleteModelLibraryEntry(home, saved.id), /不存在/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('MCP：信息包含启动命令、协议与工具列表', () => {
  const info = mcpInfo({ projectRoot: '/tmp/demo' });
  assert.equal(info.mode, 'server');
  assert.deepEqual(info.transports, ['stdio']);
  assert.equal(info.projectRoot, '/tmp/demo');
  assert.ok(info.toolCount > 0);
  assert.equal(info.tools.length, info.toolCount);
  assert.equal(info.launch.args.includes('--project'), true);
  assert.equal(info.launch.args[info.launch.args.indexOf('--project') + 1], '/tmp/demo');
  assert.deepEqual(info.clientConfig.mcpServers.promptlens, info.launch);
});
