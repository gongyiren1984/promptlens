import { createServer } from 'node:http';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { success, failure } from '../core/envelope.js';
import { createError, toPromptLensError } from '../core/errors.js';
import { readAppConfig } from '../core/app-config.js';
import { matchRoute } from './routes.js';
import { createRegistry } from './registry.js';
import {
  corsHeaders,
  createToken,
  DEFAULT_ALLOWED_ORIGINS,
  hostAllowed,
  originAllowed,
  parseBearer,
  tokenMatches,
  writeTokenFile,
} from './security.js';

const DEFAULT_MAX_BODY = 16 * 1024 * 1024;
const SSE_POLL_MS = 200;
const SSE_HEARTBEAT_MS = 15_000;

/**
 * 本地核心 API：只绑定环回地址，所有 /v1 请求需一次性令牌。
 * UI 不直接访问 SQLite 与对象库，只经此层读写。
 */
export async function startServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const home = options.home ?? process.env.PROMPTLENS_HOME ?? join(homedir(), '.promptlens');
  // 用户在工作区切换后写入 app-config；存在则优先，保证重启后仍然生效
  let configuredWorkspace = null;
  try {
    configuredWorkspace = readAppConfig(home).workspaceRoot;
  } catch {
    // 配置损坏不应阻止核心启动；/v1/app/config 会把具体错误返回给界面
    configuredWorkspace = null;
  }
  const workspace =
    configuredWorkspace && existsSync(configuredWorkspace)
      ? configuredWorkspace
      : options.workspace ?? process.cwd();
  const allowedOrigins = options.origins ?? DEFAULT_ALLOWED_ORIGINS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const token = options.token ?? createToken();
  const tokenFile = options.tokenFile ?? join(home, 'runtime', 'token');
  writeTokenFile(tokenFile, token);

  const registry = createRegistry({ workspaceRoot: workspace, home });
  const serverInfo = { host, port: 0, maxBodyBytes };
  const requestHandler = (req, res) => handleRequest(req, res, { registry, serverInfo, token, allowedOrigins, maxBodyBytes });
  const server = createServer((req, res) => {
    requestHandler(req, res).catch((error) => {
      try {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(failure(error)));
      } catch {
        /* socket 已关闭 */
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  serverInfo.port = typeof address === 'object' && address ? address.port : port;

  return {
    server,
    registry,
    token,
    tokenFile,
    endpoint: `http://${host}:${serverInfo.port}`,
    host,
    port: serverInfo.port,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      try {
        server.closeAllConnections?.();
      } catch {
        /* 旧版本 Node 无此方法 */
      }
      registry.close();
      try {
        rmSync(tokenFile, { force: true });
      } catch {
        /* 令牌文件可能已被清理 */
      }
    },
  };
}

async function handleRequest(req, res, deps) {
  const { registry, serverInfo, token, allowedOrigins, maxBodyBytes } = deps;
  const origin = req.headers.origin;
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);

  if (!hostAllowed(req.headers.host, serverInfo.port, serverInfo.host)) {
    return sendJson(req, res, 403, failure(createError('AUTH_UNAUTHORIZED', { message: 'Host 不在允许列表。' })), {});
  }
  if (!originAllowed(origin, allowedOrigins)) {
    return sendJson(req, res, 403, failure(createError('AUTH_UNAUTHORIZED', { message: 'Origin 不在允许列表。' })), {});
  }
  const cors = corsHeaders(origin, allowedOrigins);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' });
    res.end();
    return;
  }

  if (req.method === 'GET' && /^\/v1\/projects\/[^/]+\/runs\/[^/]+\/events$/.test(url.pathname)) {
    return streamRunEvents(req, res, { ...deps, url, cors });
  }

  const route = matchRoute(req.method ?? 'GET', url.pathname);
  if (!route) {
    const envelope = failure(createError('VALIDATION_INVALID_REQUEST', { message: `未知端点: ${req.method} ${url.pathname}` }));
    return sendJson(req, res, 404, envelope, cors);
  }

  if (route.route.auth !== false) {
    const presented = parseBearer(req.headers.authorization);
    if (!presented || !tokenMatches(token, presented)) {
      return sendJson(req, res, 401, failure(createError('AUTH_UNAUTHORIZED', { message: '缺少或无效的访问令牌。' })), cors);
    }
  }

  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
    try {
      body = await readJsonBody(req, maxBodyBytes);
    } catch (error) {
      return sendJson(req, res, 413, failure(createError('VALIDATION_INVALID_REQUEST', { message: error.message })), cors);
    }
  }

  const request = {
    params: route.params,
    query: Object.fromEntries(url.searchParams),
    body,
    headers: req.headers,
    registry,
    server: serverInfo,
    method: req.method,
    pathname: url.pathname,
  };

  try {
    const result = await route.route.handler(request);
    const envelope = success(result.data, {
      requestId: req.headers['x-request-id'],
      warnings: result.warnings ?? [],
    });
    return sendJson(req, res, result.status ?? 200, envelope, cors);
  } catch (error) {
    const normalized = toPromptLensError(error);
    const envelope = failure(normalized, {
      requestId: req.headers['x-request-id'],
      withTrace: true,
    });
    const status = statusForError(normalized.code);
    if (status >= 500) {
      process.stderr.write(`[promptlensd] ${normalized.code}: ${normalized.message}\n`);
    }
    return sendJson(req, res, status, envelope, cors);
  }
}

function sendJson(req, res, status, envelope, extraHeaders) {
  const payload = `${JSON.stringify(envelope)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error('请求体超过限制。');
      error.promptlensCode = 'VALIDATION_INVALID_REQUEST';
      throw error;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('请求体不是合法 JSON。');
    error.promptlensCode = 'VALIDATION_INVALID_REQUEST';
    throw error;
  }
}

const TERMINAL = new Set(['completed', 'completed_with_errors', 'canceled', 'failed']);

function streamRunEvents(req, res, { registry, token, url, cors }) {
  const presented = parseBearer(req.headers.authorization);
  if (!presented || !tokenMatches(token, presented)) {
    return sendJson(req, res, 401, failure(createError('AUTH_UNAUTHORIZED', { message: '缺少或无效的访问令牌。' })), cors);
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const projectId = decodeURIComponent(parts[2]);
  const runId = decodeURIComponent(parts[4]);
  let ctx;
  try {
    ctx = registry.ctx(projectId);
  } catch (error) {
    return sendJson(req, res, 404, failure(error), cors);
  }
  const run = ctx.db.prepare('SELECT id, status FROM runs WHERE id = ?').get(runId);
  if (!run) {
    return sendJson(req, res, 404, failure(createError('NOT_FOUND_RUN', { message: `运行不存在: ${runId}` })), cors);
  }

  let afterSeq = Number(url.searchParams.get('afterSeq') ?? 0);
  if (!Number.isFinite(afterSeq) || afterSeq < 0) afterSeq = 0;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...cors,
  });
  res.write('retry: 1000\n\n');

  const query = ctx.db.prepare('SELECT seq, type, payload_json, created_at FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq');
  let closed = false;
  let lastHeartbeat = Date.now();
  let idleTerminalTicks = 0;

  const flush = () => {
    if (closed) return;
    try {
      const rows = query.all(runId, afterSeq);
      for (const row of rows) {
        afterSeq = row.seq;
        const payload = {
          seq: row.seq,
          type: row.type,
          payload: row.payload_json ? JSON.parse(row.payload_json) : null,
          createdAt: row.created_at,
        };
        res.write(`id: ${row.seq}\ndata: ${JSON.stringify(payload)}\n\n`);
      }
      const status = ctx.db.prepare('SELECT status FROM runs WHERE id = ?').get(runId)?.status ?? run.status;
      if (TERMINAL.has(status)) {
        idleTerminalTicks += 1;
        if (!rows.length && idleTerminalTicks >= 2) {
          res.write(`event: end\ndata: ${JSON.stringify({ runId, status })}\n\n`);
          cleanup();
          return;
        }
      } else {
        idleTerminalTicks = 0;
      }
      if (Date.now() - lastHeartbeat > SSE_HEARTBEAT_MS) {
        lastHeartbeat = Date.now();
        res.write(`: ping ${Date.now()}\n\n`);
      }
    } catch {
      cleanup();
    }
  };

  const timer = setInterval(flush, SSE_POLL_MS);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    try {
      res.end();
    } catch {
      /* 已断开 */
    }
  };
  req.on('close', cleanup);
  flush();
}

function statusForError(code) {
  if (code.startsWith('AUTH_')) return code === 'AUTH_SCOPE_INSUFFICIENT' ? 403 : 401;
  if (code.startsWith('VALIDATION_')) return 400;
  if (code.startsWith('NOT_FOUND_')) return 404;
  if (code.startsWith('STATE_')) return 409;
  if (code.startsWith('BUDGET_')) return 422;
  if (code.startsWith('PROVIDER_')) return 502;
  if (code === 'INTEGRATION_CLI_TIMEOUT') return 504;
  if (code.startsWith('STORAGE_')) return 500;
  return 500;
}
