import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createError } from './errors.js';

export const APP_CONFIG_SCHEMA = 'promptlens.app-config/v1';
const MAX_PATH = 4096;

/**
 * 应用级配置（跨项目）：默认项目目录、全局工作区、引导与合规同意状态。
 * 只保存非敏感偏好；任何密钥都不得写入此文件。
 */
export function defaultAppConfig() {
  return {
    schema: APP_CONFIG_SCHEMA,
    defaultProjectRoot: null,
    workspaceRoot: null,
    onboarding: { completedAt: null, version: 1, skipped: false },
    legal: { privacyVersion: null, privacyAcceptedAt: null, termsVersion: null, termsAcceptedAt: null },
    tour: { completedVersion: null },
  };
}

export function appConfigPath(home) {
  return join(resolve(home), 'app-config.json');
}

export function readAppConfig(home) {
  const path = appConfigPath(home);
  if (!existsSync(path)) return defaultAppConfig();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw createError('VALIDATION_SCHEMA_INVALID', {
      message: `应用配置无法解析: ${error.message}`,
      details: { path },
      remediation: '修复或删除 app-config.json 后重试。',
    });
  }
  return normalizeConfig(parsed, path);
}

export function updateAppConfig(home, patch) {
  const current = readAppConfig(home);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: '应用配置更新需要对象。' });
  }
  const allowed = new Set(['defaultProjectRoot', 'workspaceRoot', 'onboarding', 'legal', 'tour']);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw createError('VALIDATION_INVALID_REQUEST', { message: `未知的应用配置字段: ${key}` });
  }
  const next = { ...current };
  if ('defaultProjectRoot' in patch) next.defaultProjectRoot = normalizePath(patch.defaultProjectRoot, 'defaultProjectRoot');
  if ('workspaceRoot' in patch) next.workspaceRoot = normalizeWorkspaceRoot(home, patch.workspaceRoot);
  if ('onboarding' in patch) next.onboarding = mergeOnboarding(current.onboarding, patch.onboarding);
  if ('legal' in patch) next.legal = mergeLegal(current.legal, patch.legal);
  if ('tour' in patch) next.tour = mergeTour(current.tour, patch.tour);
  persistAppConfig(home, next);
  return next;
}

function normalizeConfig(raw, path) {
  const defaults = defaultAppConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw corrupted(path);
  }
  if (raw.schema && raw.schema !== APP_CONFIG_SCHEMA) {
    throw createError('VALIDATION_SCHEMA_INVALID', {
      message: `应用配置 schema 不受支持: ${raw.schema}`,
      details: { path },
    });
  }
  return {
    schema: APP_CONFIG_SCHEMA,
    defaultProjectRoot: raw.defaultProjectRoot == null ? null : normalizePath(raw.defaultProjectRoot, 'defaultProjectRoot', path),
    workspaceRoot: raw.workspaceRoot == null ? null : normalizePath(raw.workspaceRoot, 'workspaceRoot', path),
    onboarding: mergeOnboarding(defaults.onboarding, raw.onboarding, path),
    legal: mergeLegal(defaults.legal, raw.legal, path),
    tour: mergeTour(defaults.tour, raw.tour, path),
  };
}

function mergeOnboarding(current, value, path) {
  if (value == null) return current;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('onboarding', path);
  assertKeys(value, ['completedAt', 'version', 'skipped'], 'onboarding', path);
  return {
    completedAt: 'completedAt' in value ? nullableIso(value.completedAt, 'onboarding.completedAt', path) : current.completedAt,
    version: 'version' in value ? positiveInteger(value.version, 'onboarding.version', path) : current.version,
    skipped: 'skipped' in value ? booleanValue(value.skipped, 'onboarding.skipped', path) : current.skipped,
  };
}

function mergeLegal(current, value, path) {
  if (value == null) return current;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('legal', path);
  const keys = ['privacyVersion', 'privacyAcceptedAt', 'termsVersion', 'termsAcceptedAt'];
  assertKeys(value, keys, 'legal', path);
  return {
    privacyVersion: 'privacyVersion' in value ? nullableText(value.privacyVersion, 'legal.privacyVersion', 64, path) : current.privacyVersion,
    privacyAcceptedAt: 'privacyAcceptedAt' in value ? nullableIso(value.privacyAcceptedAt, 'legal.privacyAcceptedAt', path) : current.privacyAcceptedAt,
    termsVersion: 'termsVersion' in value ? nullableText(value.termsVersion, 'legal.termsVersion', 64, path) : current.termsVersion,
    termsAcceptedAt: 'termsAcceptedAt' in value ? nullableIso(value.termsAcceptedAt, 'legal.termsAcceptedAt', path) : current.termsAcceptedAt,
  };
}

function mergeTour(current, value, path) {
  if (value == null) return current;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('tour', path);
  assertKeys(value, ['completedVersion'], 'tour', path);
  return {
    completedVersion:
      'completedVersion' in value ? nullablePositiveInteger(value.completedVersion, 'tour.completedVersion', path) : current.completedVersion,
  };
}

function persistAppConfig(home, config) {
  const dir = resolve(home);
  const path = join(dir, 'app-config.json');
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

function normalizePath(value, field, path) {
  if (value == null) return null;
  if (typeof value !== 'string') throw invalid(field, path);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes('\0') || trimmed.length > MAX_PATH) throw invalid(field, path);
  if (!isAbsolute(trimmed)) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: `${field} 必须是绝对路径: ${trimmed}` });
  }
  return resolve(trimmed);
}

function normalizeWorkspaceRoot(home, value) {
  const normalized = normalizePath(value, 'workspaceRoot');
  if (!normalized) return null;
  if (!existsSync(normalized)) {
    try {
      mkdirSync(normalized, { recursive: true });
    } catch (error) {
      throw createError('VALIDATION_INVALID_REQUEST', {
        message: `无法创建工作区目录: ${error.message}`,
        details: { workspaceRoot: normalized },
      });
    }
  }
  return normalized;
}

function assertKeys(value, keys, field, path) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw invalid(`${field}.${key}`, path);
  }
}

function nullableText(value, field, max, path) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(field, path);
  return value.trim();
}

function nullableIso(value, field, path) {
  if (value == null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw invalid(field, path);
  return value;
}

function positiveInteger(value, field, path) {
  if (!Number.isInteger(value) || value < 1) throw invalid(field, path);
  return value;
}

function nullablePositiveInteger(value, field, path) {
  if (value == null) return null;
  return positiveInteger(value, field, path);
}

function booleanValue(value, field, path) {
  if (typeof value !== 'boolean') throw invalid(field, path);
  return value;
}

function corrupted(path) {
  return createError('VALIDATION_SCHEMA_INVALID', {
    message: '应用配置格式无效。',
    details: { path },
    remediation: '修复或删除 app-config.json 后重试。',
  });
}

function invalid(field, path) {
  return createError('VALIDATION_INVALID_REQUEST', {
    message: `应用配置字段无效: ${field}`,
    ...(path ? { details: { path } } : {}),
  });
}
