import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(root, 'bin', 'promptlens.js');
const desktopDir = join(root, 'apps', 'desktop');
const devFile = join(root, '.promptlens-dev.json');
const devHome = join(root, '.promptlens-dev-home');
const demoProject = join(root, 'examples', 'demo', 'project');

if (!existsSync(join(demoProject, '.promptlens'))) {
  console.log('检测到演示项目缺失，先执行 npm run demo 生成数据…');
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'demo.js')], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('演示项目生成失败，请手动运行 npm run demo。');
    process.exit(1);
  }
}

console.log('启动本地核心服务…');
const server = spawn(
  process.execPath,
  [bin, 'serve', '--workspace', root, '--port', '0', '--home', devHome, '--json'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);

let vite = null;
let ready = false;

function startVite(endpoint, token, tokenFile) {
  writeFileSync(devFile, `${JSON.stringify({ endpoint, token, tokenFile, pid: server.pid }, null, 2)}\n`, { mode: 0o600 });
  console.log(`核心服务: ${endpoint}`);
  console.log('启动 Vite 开发服务器: http://localhost:5173');
  vite = spawn('npx', ['vite', '--host', '127.0.0.1'], {
    cwd: desktopDir,
    stdio: 'inherit',
    env: { ...process.env, PROMPTLENS_DEV_FILE: devFile },
  });
  vite.on('exit', (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
}

let buffer = '';
server.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\n');
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message.event === 'ready') {
        ready = true;
        const token = readFileSync(message.tokenFile, 'utf8').trim();
        startVite(message.endpoint, token, message.tokenFile);
        continue;
      }
    } catch {
      /* 非 JSON 行直接转发 */
    }
    console.log(line);
  }
});

server.stderr.on('data', (chunk) => process.stderr.write(chunk));
server.on('exit', (code) => {
  if (!ready) {
    console.error(`核心服务启动失败（exit ${code}）`);
    cleanup();
    process.exit(1);
  }
  console.error('核心服务已退出，正在关闭开发服务器…');
  vite?.kill('SIGTERM');
  cleanup();
  process.exit(0);
});

function cleanup() {
  try {
    rmSync(devFile, { force: true });
  } catch {
    /* ignore */
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    vite?.kill('SIGTERM');
    server.kill('SIGTERM');
    cleanup();
    setTimeout(() => process.exit(0), 300);
  });
}
