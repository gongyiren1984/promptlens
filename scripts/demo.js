import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const demoDir = join(root, 'examples', 'demo');
const fixtures = join(demoDir, 'fixtures');
const projectDir = join(demoDir, 'project');
const bin = join(root, 'bin', 'promptlens.js');

function cli(args) {
  const raw = execFileSync(process.execPath, [bin, ...args, '--json'], { encoding: 'utf8' });
  const envelope = JSON.parse(raw);
  if (!envelope.ok) {
    throw new Error(`${args.join(' ')} 失败: ${envelope.error.code} ${envelope.error.message}`);
  }
  return envelope.data;
}

console.log('1/8 创建演示项目');
rmSync(projectDir, { recursive: true, force: true });
const project = cli(['project', 'create', projectDir, '--name', '客服回复质量实验']);
console.log(`    projectId=${project.projectId}`);

console.log('2/8 导入提示词（A/B 两个分支）');
const prompts = cli(['prompts', 'import', '--project', projectDir, '--file', join(fixtures, 'prompts.json')]);
const variantA = prompts.variants.find((item) => item.label === 'A');
const variantB = prompts.variants.find((item) => item.label === 'B');
console.log(`    A=${variantA.versionId} B=${variantB.versionId}`);

console.log('3/8 导入用例并创建测试集');
const cases = cli(['cases', 'import', '--project', projectDir, '--file', join(fixtures, 'cases.json'), '--set', '基础集']);
console.log(`    cases=${cases.caseCount} testSetVersionId=${cases.testSetVersionId}`);

console.log('4/8 创建评分方案');
const evaluation = cli(['eval-profiles', 'create', '--project', projectDir, '--name', '客服质量规则', '--file', join(fixtures, 'evaluation.json')]);
console.log(`    profileVersionId=${evaluation.profileVersionId}`);

console.log('5/8 添加 mock 模型（带价格表）');
const model = cli([
  'models',
  'add',
  '--project',
  projectDir,
  '--name',
  'mock-primary',
  '--provider',
  'mock',
  '--model-id',
  'mock-large',
  '--pricing',
  JSON.stringify({ currency: 'USD', unit: 'per_request', perRequest: '0.002' }),
]);
const modelInfo = cli(['models', 'show', 'mock-primary', '--project', projectDir]);
console.log(`    modelConfigVersionId=${model.modelConfigVersionId}`);

const spec = {
  schema: 'promptlens.experiment/v1',
  projectId: project.projectId,
  name: '客服回复 A/B 演示',
  description: '12 条用例 × 2 个分支 × 2 次重复，使用 mock 提供方验证完整链路。',
  variants: [
    { label: 'A', promptVersionId: variantA.versionId, contentHash: variantA.contentHash },
    { label: 'B', promptVersionId: variantB.versionId, contentHash: variantB.contentHash },
  ],
  testSet: { testSetVersionId: cases.testSetVersionId, contentHash: cases.contentHash },
  models: [
    {
      modelConfigVersionId: model.modelConfigVersionId,
      modelProfileId: modelInfo.profileId,
      contentHash: modelInfo.contentHash,
    },
  ],
  repetitions: 2,
  execution: { order: 'sequential', maxAttempts: 3, backoffBaseMs: 50, maxBackoffMs: 200, maxConcurrency: 4 },
  evaluation: { profileVersionId: evaluation.profileVersionId, contentHash: evaluation.contentHash, judgeRepetitions: 1 },
  budget: {
    maxRequests: 200,
    maxDurationSeconds: 300,
    maxAmount: { amount: '1.00', currency: 'USD' },
  },
};
const specPath = join(projectDir, 'experiment.json');
writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

console.log('6/8 预检');
const preflight = cli(['run', 'preflight', '--project', projectDir, '--spec', specPath]);
console.log(`    trialCount=${preflight.trialCount} warnings=${preflight.warnings.map((item) => item.code).join(',') || '无'}`);

console.log('7/8 执行运行（前台）');
const run = cli([
  'run',
  'start',
  '--project',
  projectDir,
  '--spec',
  specPath,
  '--idempotency-key',
  'demo-run-001',
  '--foreground',
]);
console.log(`    runId=${run.runId} status=${run.status ?? 'completed'}`);

const status = cli(['run', 'status', run.runId, '--project', projectDir]);
console.log(`    计数: ${JSON.stringify(status.counts)}`);

console.log('8/8 生成 Markdown 报告');
const report = cli(['report', 'generate', run.runId, '--project', projectDir]);
console.log(`    reportId=${report.reportId}`);
console.log(`    path=${join(projectDir, report.path)}`);
console.log(`    结论: ${report.summary.status}，有效输出率 ${(report.summary.outputValidRate * 100).toFixed(1)}%`);

const markdown = readFileSync(join(projectDir, report.path), 'utf8');
const headings = markdown.split('\n').filter((line) => line.startsWith('## '));
console.log(`    报告章节: ${headings.map((line) => line.replace('## ', '')).join(' / ')}`);

console.log('\n演示完成。可用以下命令继续查看：');
console.log(`  node bin/promptlens.js prompts diff ${variantA.versionId} ${variantB.versionId} --project ${projectDir} --json`);
console.log(`  node bin/promptlens.js run status ${run.runId} --project ${projectDir} --outputs --json`);
console.log(`  node bin/promptlens.js report show ${report.reportId} --project ${projectDir}`);
