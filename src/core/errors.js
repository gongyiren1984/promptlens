import catalog from '../../schemas/error-catalog.json' with { type: 'json' };

const CODE_INDEX = new Map(catalog.codes.map((entry) => [entry.code, entry]));
const FAMILIES = [...catalog.families].sort((a, b) => b.prefix.length - a.prefix.length);

export class PromptLensError extends Error {
  constructor(code, message, options = {}) {
    const entry = CODE_INDEX.get(code);
    const family = FAMILIES.find((item) => code.startsWith(item.prefix));
    super(message || entry?.message || family?.meaning || code);
    this.name = 'PromptLensError';
    this.code = code;
    this.retryable = options.retryable ?? entry?.retryable ?? family?.defaultRetryable ?? false;
    this.scope = options.scope ?? entry?.scope ?? 'system';
    this.details = options.details ?? null;
    this.remediation = options.remediation ?? entry?.remediation;
    this.exitCode = resolveExitCode(code, this.retryable);
  }
}

export function resolveExitCode(code, retryable) {
  const entry = CODE_INDEX.get(code);
  if (entry?.family === 'PROVIDER_' || entry?.family === 'INTEGRATION_') {
    if (entry.exitCode != null) return entry.exitCode;
    return retryable ? 10 : 11;
  }
  if (entry?.exitCode != null) return entry.exitCode;
  const family = FAMILIES.find((item) => code.startsWith(item.prefix));
  if (!family) return 11;
  if (family.cliExitCode != null) return family.cliExitCode;
  return retryable ? 10 : 11;
}

export function createError(code, options = {}) {
  return new PromptLensError(code, options.message, options);
}

/** 将任意异常归一到 PromptLensError，未知错误不吞掉原始信息。 */
export function toPromptLensError(error) {
  if (error instanceof PromptLensError) return error;
  if (error?.name === 'AbortError') {
    return new PromptLensError('STATE_INVALID_TRANSITION', '操作已被取消。', { retryable: false });
  }
  const message = error?.message || String(error);
  return new PromptLensError('INTERNAL_UNEXPECTED', message, { details: { originalName: error?.name } });
}

export function errorCatalogEntry(code) {
  return CODE_INDEX.get(code) ?? null;
}

export function catalogSummary() {
  return catalog.codes.map((entry) => ({
    code: entry.code,
    retryable: entry.retryable,
    exitCode: resolveExitCode(entry.code, entry.retryable ?? false),
    scope: entry.scope,
    message: entry.message,
  }));
}
