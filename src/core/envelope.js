import { API_VERSION, SERVER_VERSION } from '../version.js';
import { nowIso } from './time.js';
import { requestId as makeRequestId, traceId as makeTraceId } from './ids.js';
import { toPromptLensError, resolveExitCode } from './errors.js';

export function success(data, options = {}) {
  return {
    apiVersion: API_VERSION,
    requestId: options.requestId ?? makeRequestId(),
    ok: true,
    data,
    warnings: options.warnings ?? [],
    error: null,
    meta: buildMeta(options),
  };
}

export function failure(error, options = {}) {
  const normalized = toPromptLensError(error);
  return {
    apiVersion: API_VERSION,
    requestId: options.requestId ?? makeRequestId(),
    ok: false,
    warnings: options.warnings ?? [],
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: Boolean(normalized.retryable),
      scope: normalized.scope,
      ...(normalized.details ? { details: normalized.details } : {}),
      ...(normalized.remediation ? { remediation: normalized.remediation } : {}),
    },
    meta: buildMeta(options),
  };
}

function buildMeta(options) {
  const meta = {
    serverVersion: SERVER_VERSION,
    completedAt: nowIso(),
  };
  if (options.traceId) meta.traceId = options.traceId;
  else if (options.withTrace) meta.traceId = makeTraceId();
  if (typeof options.durationMs === 'number') meta.durationMs = Math.max(0, Math.round(options.durationMs));
  return meta;
}

export function exitCodeForEnvelope(envelope) {
  if (envelope.ok) return 0;
  if (envelope.error.code === 'INTEGRATION_CLI_TIMEOUT') return 124;
  return resolveExitCode(envelope.error.code, envelope.error.retryable);
}
