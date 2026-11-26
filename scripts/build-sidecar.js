#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'dist-sidecar');
const bundlePath = join(outDir, 'promptlens.cjs');
const blobPath = join(outDir, 'sea-prep.blob');
const sidecarPath = join(outDir, 'promptlens-sidecar');
const seaConfigPath = join(outDir, 'sea-config.json');

mkdirSync(outDir, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 失败（exit ${result.status}）`);
  }
}

console.log('1/5 打包 Node 单文件入口');
run('npx', ['--yes', 'esbuild', 'scripts/sidecar-entry.js', '--bundle', '--platform=node', '--format=cjs', '--target=node24', `--outfile=${bundlePath}`, '--log-level=warning']);

console.log('2/5 写入 SEA 配置');
writeFileSync(
  seaConfigPath,
  `${JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true }, null, 2)}\n`,
  'utf8',
);

console.log('3/5 生成 SEA blob');
run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

console.log('4/5 注入 Node 可执行文件');
copyFileSync(process.execPath, sidecarPath);
if (process.platform === 'darwin') {
  try {
    execFileSync('codesign', ['--remove-signature', sidecarPath], { stdio: 'ignore' });
  } catch {
    /* 未签名二进制可跳过 */
  }
}
const postjectArgs = [
  '--yes',
  'postject',
  sidecarPath,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run('npx', postjectArgs);

if (process.platform === 'darwin') {
  console.log('5/5 ad-hoc 重新签名');
  try {
    execFileSync('codesign', ['--sign', '-', '--force', sidecarPath], { stdio: 'inherit' });
  } catch {
    console.warn('ad-hoc 签名失败；本地运行可能仍可用，但分发前必须完成正式签名与公证。');
  }
}

console.log('验证 sidecar 握手…');
const probe = spawnSync(sidecarPath, ['capabilities', '--json'], { encoding: 'utf8', cwd: root });
if (probe.status !== 0) {
  console.error(probe.stderr || probe.stdout);
  throw new Error('sidecar 自检失败');
}
const envelope = JSON.parse(probe.stdout);
if (!envelope.ok) throw new Error(`sidecar 返回错误: ${envelope.error?.code}`);
console.log(`完成: ${sidecarPath}`);
console.log(`大小: ${(readFileSync(sidecarPath).length / 1024 / 1024).toFixed(1)} MB`);
console.log(`版本: ${envelope.data.serverVersion}`);

if (!existsSync(join(outDir, 'promptlens-sidecar'))) {
  rmSync(outDir, { recursive: true, force: true });
  throw new Error('未生成 sidecar');
}
