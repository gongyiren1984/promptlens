import { execFileSync } from 'node:child_process';
import { createError } from './errors.js';

export const KEYCHAIN_SERVICE = 'promptlens';
const MAX_SECRET_LENGTH = 1024;

/**
 * 把 API Key 写入系统钥匙串，返回可供模型配置引用的 credentialRef。
 * 核心只在内存中短暂持有明文，项目数据库与快照只保存 keychain: 引用。
 */
export function storeKeychainCredential(input, options = {}) {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? execFileSync;
  if (platform !== 'darwin') {
    throw createError('AUTH_CREDENTIAL_UNAVAILABLE', {
      message: '当前平台未接入系统钥匙串，请改用 env: 引用。',
      details: { platform },
    });
  }
  const secret = String(input?.key ?? '').trim();
  if (!secret) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: 'API Key 不能为空。' });
  }
  if (secret.length > MAX_SECRET_LENGTH || /\s/.test(secret)) {
    throw createError('VALIDATION_INVALID_REQUEST', {
      message: 'API Key 长度需在 1—1024 之间且不能包含空白字符。',
      remediation: '请粘贴完整的 API Key，避免换行或多余空格。',
    });
  }
  const account = credentialAccount(input?.account);
  try {
    run('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', secret], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    throw createError('AUTH_CREDENTIAL_UNAVAILABLE', {
      message: `写入系统钥匙串失败: ${error?.message ?? '未知错误'}`,
      remediation: '确认「钥匙串访问」可用，或改用 keychain: 手动创建条目。',
    });
  }
  return { credentialRef: `keychain:${KEYCHAIN_SERVICE}:${account}` };
}

/** 把模型名压缩为钥匙串 account 可用的 ASCII 标识。 */
export function credentialAccount(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'default';
}
