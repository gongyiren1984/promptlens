import { createHash } from 'node:crypto';

/** 稳定序列化：对象键排序、短路 null，用于内容哈希与幂等比较。 */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortValue(value[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function hashText(text) {
  return `sha256:${sha256Hex(normalizeText(text))}`;
}

export function hashJson(value) {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/** 文本规范化：去 BOM、统一 LF，不在正文末尾追加换行。 */
export function normalizeText(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}
