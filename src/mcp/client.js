import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { MCP_DEFAULT_PROTOCOL_VERSION, SERVER_VERSION } from '../version.js';

/**
 * 最小 MCP Client：JSON-RPC 2.0 over stdio，覆盖 initialize / tools/list / tools/call。
 * 传输层可替换（stdio 或内存），便于在测试中直接连接本地 MCP Server。
 */
export class McpClient {
  constructor({ transport, clientInfo = { name: 'promptlens-client', version: SERVER_VERSION } } = {}) {
    if (!transport) throw new Error('McpClient 需要 transport');
    this.transport = transport;
    this.clientInfo = clientInfo;
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.protocolVersion = null;
    this.serverInfo = null;
    transport.onMessage((message) => this.#handleMessage(message));
  }

  #handleMessage(message) {
    if (!message || message.id === undefined) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message ?? 'MCP 请求失败');
      error.code = message.error.code;
      error.data = message.error.data;
      entry.reject(error);
    } else {
      entry.resolve(message.result);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.transport.write({ jsonrpc: '2.0', method, params });
  }

  async initialize(protocolVersion = MCP_DEFAULT_PROTOCOL_VERSION) {
    const result = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    this.protocolVersion = result.protocolVersion;
    this.serverInfo = result.serverInfo;
    this.initialized = true;
    this.notify('notifications/initialized');
    return result;
  }

  async listTools() {
    const result = await this.request('tools/list', {});
    return result.tools;
  }

  async callTool(name, args = {}) {
    return this.request('tools/call', { name, arguments: args });
  }

  /** 调用工具并直接返回业务 data；失败时抛出带 envelope 的错误。 */
  async callToolData(name, args = {}) {
    const result = await this.callTool(name, args);
    if (result?.isError) {
      const envelope = result.structuredContent ?? null;
      const error = new Error(envelope?.error?.message ?? `MCP 工具调用失败: ${name}`);
      error.code = envelope?.error?.code ?? 'INTEGRATION_MCP_FAILED';
      error.envelope = envelope;
      throw error;
    }
    return result?.structuredContent?.data ?? result?.structuredContent ?? null;
  }

  close() {
    this.transport.close?.();
  }
}

/** 通过子进程 stdio 连接 MCP Server。 */
export function stdioTransport({ command, args = [], env = process.env, cwd } = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env, cwd });
  const listeners = [];
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    listeners.forEach((listener) => listener(message));
  });
  return {
    child,
    write(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(listener) {
      listeners.push(listener);
    },
    close() {
      try {
        child.stdin.end();
      } catch {
        /* 已关闭 */
      }
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    },
  };
}
