import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256Hex } from './hash.js';
import { createError } from './errors.js';

function objectPath(root, hex) {
  return join(root, '.promptlens', 'objects', 'sha256', hex.slice(0, 2), hex.slice(2, 4), hex);
}

export function hasObject(root, ref) {
  const hex = ref.startsWith('sha256:') ? ref.slice(7) : ref;
  return existsSync(objectPath(root, hex));
}

/** 写入内容对象：临时文件 → fsync → 哈希校验 → 原子 rename。 */
export function putObject(root, content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const hex = sha256Hex(buffer);
  const target = objectPath(root, hex);
  if (existsSync(target)) {
    // 已存在时校验哈希一致，避免静默覆盖损坏对象
    const existing = readFileSync(target);
    if (sha256Hex(existing) !== hex) {
      throw createError('STORAGE_OBJECT_MISSING', { message: '同哈希对象内容不一致，拒绝覆盖。', details: { ref: `sha256:${hex}` } });
    }
    return { ref: `sha256:${hex}`, hex, path: relativeObjectPath(hex), size: buffer.length };
  }
  mkdirSync(join(target, '..'), { recursive: true });
  const temp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, buffer);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  return { ref: `sha256:${hex}`, hex, path: relativeObjectPath(hex), size: buffer.length };
}

export function getObject(root, ref) {
  const hex = ref.startsWith('sha256:') ? ref.slice(7) : ref;
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: `对象引用格式非法: ${ref}` });
  }
  const path = objectPath(root, hex);
  if (!existsSync(path)) {
    throw createError('STORAGE_OBJECT_MISSING', { message: '内容对象不存在。', details: { ref } });
  }
  const buffer = readFileSync(path);
  if (sha256Hex(buffer) !== hex) {
    throw createError('STORAGE_OBJECT_MISSING', { message: '内容对象哈希校验失败。', details: { ref } });
  }
  return { ref: `sha256:${hex}`, buffer, text: buffer.toString('utf8'), size: buffer.length };
}

export function deleteObject(root, ref) {
  const hex = ref.startsWith('sha256:') ? ref.slice(7) : ref;
  rmSync(objectPath(root, hex), { force: true });
}

function relativeObjectPath(hex) {
  return `.promptlens/objects/sha256/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`;
}
