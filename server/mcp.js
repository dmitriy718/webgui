'use strict';

/**
 * mcp.js — MCP (Model Context Protocol) client.
 *
 * Speaks JSON-RPC 2.0 with two transports:
 *   1. stdio — spawns a child process, exchanges newline-delimited JSON.
 *   2. http  — streamable HTTP: POST JSON-RPC to the endpoint; the server
 *              replies with either a plain JSON body or an SSE stream.
 *
 * The client performs the MCP `initialize` handshake (protocolVersion
 * "2025-06-18"), sends `notifications/initialized`, then exposes
 * tools/list and tools/call.
 */

const { spawn } = require('child_process');
const { randomBytes } = require('crypto');

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const CLIENT_INFO = { name: 'webgui', version: '1.0.0' };

class McpError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

/** Base JSON-RPC framing logic shared by both transports. */
class JsonRpcSession {
  constructor({ timeoutMs = 30000 } = {}) {
    this.timeoutMs = timeoutMs;
    this._nextId = 1;
    /** @type {Map<number, {resolve, reject, timer}>} */
    this._pending = new Map();
    this.onClose = null;
    this.onLog = null;
    this._closed = false;
  }

  /** Subclasses implement this to send a raw JSON-RPC message. */
  _send(msg) { throw new Error('_send not implemented'); }

  /** Handle an incoming JSON-RPC message. */
  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    // Response to a request we made.
    if (typeof msg.id === 'number' && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new McpError(msg.error.message || 'MCP error', msg.error.code, msg.error.data));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    // Notification (no id) or server-initiated request — we ignore server
    // requests (we don't expose resources/prompts to the server), but we
    // log notifications like notifications/cancelled for debugging.
    if (msg.method && msg.id === undefined) {
      if (this.onLog) this.onLog('notification', msg.method);
    }
  }

  /** Send a request and await the response. */
  request(method, params = {}, { timeoutMs } = {}) {
    if (this._closed) return Promise.reject(new McpError('session closed', -32000));
    const id = this._nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new McpError(`MCP request ${method} timed out after ${timeoutMs || this.timeoutMs}ms`, -32001, { timeoutMs: timeoutMs || this.timeoutMs }));
      }, timeoutMs || this.timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._send(msg);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  /** Send a fire-and-forget notification. */
  notify(method, params = {}) {
    if (this._closed) return;
    try {
      this._send({ jsonrpc: '2.0', method, params });
    } catch (err) {
      if (this.onLog) this.onLog('notify-error', `${method}: ${err.message}`);
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new McpError('session closed', -32000));
      this._pending.delete(id);
    }
    if (this.onClose) {
      try { this.onClose(); } catch { /* ignore */ }
    }
  }
}

/** stdio transport: spawns the MCP server process, NDJSON framing. */
class StdioSession extends JsonRpcSession {
  constructor(def, opts = {}) {
    super(opts);
    this.def = def;
    this.proc = null;
    this._stdoutBuf = '';
    this._stderrBuf = '';
    this._spawned = false;
    this.onClose = () => this._teardown('closed');
  }

  async connect() {
    this._spawn();
  }

  _spawn() {
    const { command, args = [], env = {}, cwd } = this.def;
    const procEnv = { ...process.env, ...env };
    if (process.platform === 'win32' && procEnv.Path && !procEnv.PATH) procEnv.PATH = procEnv.Path;
    this.proc = spawn(command, args, {
      cwd: cwd || process.cwd(),
      env: procEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this._spawned = true;

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this._stdoutBuf += chunk;
      let idx;
      while ((idx = this._stdoutBuf.indexOf('\n')) !== -1) {
        const line = this._stdoutBuf.slice(0, idx).trim();
        this._stdoutBuf = this._stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch {
          if (this.onLog) this.onLog('bad-stdout', line.slice(0, 200));
          continue;
        }
        this._handleMessage(msg);
      }
    });

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      this._stderrBuf += chunk;
      if (this._stderrBuf.length > 64 * 1024) this._stderrBuf = this._stderrBuf.slice(-32 * 1024);
      if (this.onLog) {
        for (const line of chunk.split('\n')) {
          if (line.trim()) this.onLog('stderr', line.trim());
        }
      }
    });

    this.proc.on('error', (err) => {
      if (this.onLog) this.onLog('error', `spawn: ${err.message}`);
      this._teardown(`spawn error: ${err.message}`);
    });

    this.proc.on('exit', (code, signal) => {
      this._teardown(`process exited (code=${code}, signal=${signal})`);
    });
  }

  _send(msg) {
    if (!this.proc || this.proc.killed || !this.proc.stdin.writable) {
      throw new McpError('stdio pipe not writable', -32000);
    }
    this.proc.stdin.write(JSON.stringify(msg) + '\n', 'utf8', (err) => {
      if (err && this.onLog) this.onLog('write-error', err.message);
    });
  }

  _teardown(reason) {
    if (this.onLog) this.onLog('teardown', reason || 'unknown');
    this.close();
    if (this._spawned && this.proc && !this.proc.killed) {
      try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
      const proc = this.proc;
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, 3000).unref();
    }
  }

  recentStderr() {
    return this._stderrBuf.slice(-2000);
  }
}

/** Streamable HTTP transport. */
class HttpSession extends JsonRpcSession {
  constructor(def, opts = {}) {
    super(opts);
    this.def = def;
    this._sessionId = null;
    this._fetchTimeoutMs = opts.fetchTimeoutMs || 30000;
  }

  async connect() {
    // No preflight needed; lazily established on first request.
  }

  _headers() {
    const h = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.def.headers || {}),
    };
    if (this._sessionId) h['mcp-session-id'] = this._sessionId;
    if (this.def.apiKey) h.authorization = `Bearer ${this.def.apiKey}`;
    return h;
  }

  async _send(msg) {
    const url = String(this.def.url || '').trim();
    if (!url) throw new McpError('http transport requires a url', -32602);
    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(this._fetchTimeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this._sessionId = sid;

    if (msg.method !== undefined && msg.id !== undefined && msg.method !== 'initialize' && !res.ok) {
      const text = await res.text().catch(() => '');
      throw new McpError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
    }

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/event-stream')) {
      // Read SSE; take the first data payload as our response.
      const text = await res.text();
      for (const line of text.split('\n')) {
        const l = line.replace(/\r$/, '').trim();
        if (!l.startsWith('data:')) continue;
        const data = l.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const obj = JSON.parse(data);
          this._handleMessage(obj);
          return;
        } catch { /* keep scanning */ }
      }
      return;
    }
    const text = await res.text();
    if (!text.trim()) return;
    let obj;
    try { obj = JSON.parse(text); } catch {
      throw new McpError(`invalid JSON response: ${text.slice(0, 200)}`, -32000);
    }
    if (Array.isArray(obj)) obj.forEach((o) => this._handleMessage(o));
    else this._handleMessage(obj);
  }

  _teardown() {
    this.close();
  }
}

/**
 * High-level MCP server handle wrapping a session + handshake state.
 */
class McpServer {
  /**
   * @param {object} def {id, name, kind:'stdio'|'http', command, args, env, cwd, url, headers, apiKey}
   * @param {object} [opts]
   * @param {(level:string, msg:string)=>void} [opts.onLog]
   */
  constructor(def, opts = {}) {
    this.def = { kind: 'stdio', args: [], env: {}, ...def };
    this.id = this.def.id;
    this.name = this.def.name || this.def.id;
    this.state = 'disconnected'; // disconnected | connecting | connected | error
    this.error = null;
    this.serverInfo = null;
    this.protocolVersion = null;
    this.tools = [];
    this.onLog = opts.onLog || (() => {});
    this.onStateChange = opts.onStateChange || (() => {});
    this._session = null;
    this._toolsRefreshTimer = null;
  }

  _setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.onStateChange(this);
  }

  _log(level, msg) {
    this.onLog(`[${this.id}] ${level}: ${msg}`);
  }

  async connect() {
    if (this.state === 'connected' || this.state === 'connecting') return this;
    this._setState('connecting');
    const isStdio = this.def.kind === 'stdio';
    const session = isStdio ? new StdioSession(this.def, { timeoutMs: this.def.timeoutMs }) : new HttpSession(this.def, { timeoutMs: this.def.timeoutMs });
    session.onLog = (level, msg) => this._log(level, msg);
    if (isStdio) {
      session.onClose = () => {
        if (this.state === 'connected') {
          this._setState('error', 'stdio connection closed');
        }
      };
    }
    this._session = session;
    await session.connect();

    // Handshake.
    let result;
    try {
      result = await session.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          // We support tools only; no prompts/resources/sampling needed.
        },
        clientInfo: CLIENT_INFO,
      });
    } catch (err) {
      session.close();
      this._session = null;
      this._setState('error', `initialize failed: ${err.message}`);
      throw err;
    }

    this.serverInfo = result.serverInfo || null;
    this.protocolVersion = result.protocolVersion || null;
    if (!SUPPORTED_VERSIONS.includes(result.protocolVersion)) {
      this._log('warn', `server reported protocol version ${result.protocolVersion} (not in supported list); continuing`);
    }
    session.notify('notifications/initialized', {});

    await this.refreshTools();
    this._setState('connected');
    return this;
  }

  /** Fetch tools/list from the server. */
  async refreshTools() {
    if (!this._session) return [];
    const result = await this._session.request('tools/list', {});
    const tools = Array.isArray(result && result.tools) ? result.tools : [];
    this.tools = tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
    if (result.nextCursor && this.def.autoListPages) {
      // Paginated tools/list — fetch remaining pages.
      let cursor = result.nextCursor;
      const guard = 100;
      while (cursor && guard-- > 0) {
        const more = await this._session.request('tools/list', { cursor });
        for (const t of (more && more.tools) || []) {
          this.tools.push({
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema || { type: 'object', properties: {} },
          });
        }
        cursor = more && more.nextCursor;
      }
    }
    return this.tools;
  }

  /**
   * Call a tool.
   * @param {string} name tool name (as listed by this server)
   * @param {object} args arguments
   * @returns {Promise<{content:any[], isError?:boolean}>} raw MCP result
   */
  async callTool(name, args) {
    if (!this._session) throw new McpError('not connected', -32000);
    const result = await this._session.request('tools/call', { name, arguments: args || {} }, {
      timeoutMs: this.def.callTimeoutMs || 120000,
    });
    return {
      content: (result && result.content) || [],
      isError: !!(result && result.isError),
      structuredContent: result && result.structuredContent,
    };
  }

  /** Serialize tool results (content list) into a single string for chat context. */
  static stringifyContent(content) {
    if (!Array.isArray(content)) return String(content);
    const parts = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') { parts.push(String(item)); continue; }
      switch (item.type) {
        case 'text':
          parts.push(item.text || '');
          break;
        case 'image':
          parts.push(`[image: ${item.mimeType || 'image'}; ${(item.data || '').length} bytes of base64]`);
          break;
        case 'resource':
          if (item.resource && item.resource.text) parts.push(item.resource.text);
          else parts.push(`[resource: ${(item.resource && item.resource.uri) || 'unknown'}]`);
          break;
        default:
          parts.push(JSON.stringify(item));
      }
    }
    return parts.join('\n');
  }

  disconnect() {
    if (this._toolsRefreshTimer) {
      clearInterval(this._toolsRefreshTimer);
      this._toolsRefreshTimer = null;
    }
    const s = this._session;
    this._session = null;
    this.tools = [];
    this._setState('disconnected');
    if (s) {
      // Best-effort graceful shutdown.
      try { s.notify('notifications/cancelled', { requestId: null }); } catch { /* ignore */ }
      s.close();
    }
  }
}

/** Convert MCP tool definitions to OpenAI function tools, namespaced per server. */
function toOpenAITools(servers) {
  const out = [];
  for (const srv of servers) {
    if (srv.state !== 'connected') continue;
    for (const tool of srv.tools) {
      out.push({
        type: 'function',
        function: {
          name: `${srv.id}__${tool.name}`,
          description: tool.description || `MCP tool ${tool.name} from server ${srv.name}`,
          parameters: tool.inputSchema || { type: 'object', properties: {} },
        },
      });
    }
  }
  return out;
}

/** Parse a namespaced tool name into {serverId, toolName} or null. */
function parseNamespacedTool(name) {
  if (typeof name !== 'string') return null;
  const idx = name.indexOf('__');
  if (idx <= 0 || idx === name.length - 2) return null;
  return { serverId: name.slice(0, idx), toolName: name.slice(idx + 2) };
}

/** Generate a random id for an MCP server definition. */
function mcpServerId() {
  return `mcp_${randomBytes(5).toString('hex')}`;
}

module.exports = {
  McpError,
  McpServer,
  StdioSession,
  HttpSession,
  toOpenAITools,
  parseNamespacedTool,
  mcpServerId,
  PROTOCOL_VERSION,
};
