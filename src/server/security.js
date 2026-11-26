import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_ALLOWED_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

export function createToken() {
  return randomBytes(32).toString('hex');
}

/** 一次性令牌写入 0600 文件；桌面壳读取后由前端通过内存持有，不进入持久化存储。 */
export function writeTokenFile(path, token) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* 某些文件系统不支持 chmod，权限已由写入模式约束 */
  }
  return path;
}

export function tokenMatches(expected, presented) {
  if (typeof presented !== 'string' || presented.length !== expected.length) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseBearer(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export function originAllowed(origin, allowed) {
  if (!origin) return true;
  return allowed.includes(origin);
}

export function hostAllowed(host, port, hostname) {
  if (!host) return false;
  const expected = [`${hostname}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`];
  return expected.includes(host.toLowerCase());
}

export function corsHeaders(origin, allowed) {
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,Idempotency-Key,X-Request-Id',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
