import { randomBytes, randomUUID } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastMs = 0;
let lastRandom = [];

/** ULID 风格 26 位有序 ID：时间前缀 + 80bit 随机，满足 id schema 字符集要求。 */
export function ulid(now = Date.now()) {
  let ms = now;
  let randomPart;
  if (ms === lastMs && lastRandom.length) {
    // 同毫秒内单调递增，避免排序抖动
    randomPart = incrementRandom(lastRandom);
  } else {
    randomPart = Array.from(randomBytes(10));
  }
  lastMs = ms;
  lastRandom = randomPart;

  let time = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  let bits = 0;
  let value = 0;
  for (const byte of randomPart) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      rand += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return (time + rand).slice(0, 26);
}

function incrementRandom(bytes) {
  const copy = [...bytes];
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i] === 255) {
      copy[i] = 0;
    } else {
      copy[i] += 1;
      break;
    }
  }
  return copy;
}

export function requestId() {
  return `req_${ulid()}`;
}

export function traceId() {
  return `trace_${ulid()}`;
}

export function uuid() {
  return randomUUID();
}

/** UI 写操作的默认幂等键：服务端不信任客户端时间，只要求稳定唯一。 */
export function newIdempotencyKey() {
  return `ui_${randomUUID()}`;
}
