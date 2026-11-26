import { ulid } from './ids.js';
import { nowIso } from './time.js';

/** 审计事件与诊断日志分离：这里只记录不可变业务动作，不写密钥。 */
export function recordAudit(ctx, type, payload = {}, actor = ctx?.actor ?? 'cli') {
  const safe = sanitize(payload);
  ctx.db
    .prepare('INSERT INTO audit_events(id, type, actor, payload_json, created_at) VALUES(?,?,?,?,?)')
    .run(ulid(), type, actor, JSON.stringify(safe), nowIso());
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/secret|token|password|authorization|api[_-]?key/i.test(key)) continue;
      out[key] = sanitize(item);
    }
    return out;
  }
  return value;
}
