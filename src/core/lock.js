import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createError } from './errors.js';
import { nowIso } from './time.js';

function lockPath(root) {
  return join(root, '.promptlens', 'project.lock');
}

/** 运行时单写锁：进程退出后残留锁可被识别并清理。 */
export function acquireProjectLock(root) {
  const path = lockPath(root);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      const payload = JSON.stringify({ pid: process.pid, createdAt: nowIso() });
      writeSync(fd, payload);
      closeSync(fd);
      return {
        path,
        release() {
          rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        holder = null;
      }
      if (holder?.pid && isAlive(holder.pid)) {
        throw createError('STATE_INVALID_TRANSITION', {
          message: `项目正在被进程 ${holder.pid} 写入，请稍后重试。`,
          details: { pid: holder.pid, since: holder.createdAt },
        });
      }
      rmSync(path, { force: true });
    }
  }
  throw createError('STATE_INVALID_TRANSITION', { message: '无法获取项目写锁。' });
}

function isAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readProjectLock(root) {
  const path = lockPath(root);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { pid: null, createdAt: null };
  }
}
