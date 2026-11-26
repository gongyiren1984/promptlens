export function nowIso() {
  return new Date().toISOString();
}

const DURATION_UNITS = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** 解析 `30m` / `500ms` / `2h` 等时长，返回毫秒。 */
export function parseDuration(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  const text = String(input ?? '').trim();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(text);
  if (!match) return null;
  const unit = (match[2] || 'ms').toLowerCase();
  return Math.round(Number(match[1]) * DURATION_UNITS[unit]);
}

export function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
