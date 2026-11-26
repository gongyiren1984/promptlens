import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** SEA 单文件分发时不存在源码路径，此时直接用可执行文件自身作为 CLI 入口。 */
const CLI_BIN = (() => {
  try {
    const candidate = fileURLToPath(new URL('../../bin/promptlens.js', import.meta.url));
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
})();

/** 后台执行 run：脱离父进程，日志落在项目 .promptlens/logs。 */
export function spawnRunWorker(root, runId) {
  const logDir = join(root, '.promptlens', 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFd = openSync(join(logDir, `worker-${runId}.log`), 'a');
  const args = CLI_BIN
    ? [CLI_BIN, 'run', 'worker', runId, '--project', root, '--json']
    : ['run', 'worker', runId, '--project', root, '--json'];
  const child = spawn(process.execPath, args, {
    cwd: root,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PROMPTLENS_DETACHED: '1' },
  });
  child.on('error', () => {});
  child.unref();
  closeSync(logFd);
  return { runId, pid: child.pid ?? null, logFile: join('.promptlens', 'logs', `worker-${runId}.log`) };
}
