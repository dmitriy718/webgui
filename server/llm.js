'use strict';

/**
 * llm.js — OpenAI-compatible chat client.
 *
 * Works with Ollama (via its /v1 compatibility layer), LM Studio, vLLM,
 * llama.cpp server, llama-factory, and any other OpenAI-compatible API.
 *
 * SSE stream events emitted via onEvent(type, data):
 *   - { type:'delta', content }        assistant text chunk
 *   - { type:'reasoning', content }    reasoning/thinking chunk (if present)
 *   - { type:'tool_call', toolCall }   full tool call (assembled)
 *   - { type:'usage', usage }          token usage when reported
 *   - { type:'done', finishReason }    stream finished
 *   - { type:'error', message }        stream-level error
 */

const { truncate } = require('./util');

/**
 * Return the normalized API base URL (ending without a trailing slash)
 * for a provider definition. `kind` is 'ollama' or 'openai'.
 */
function providerBaseUrl(provider) {
  let url = String(provider.baseUrl || 'http://localhost:11434').trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  // Strip any path so we always append our own.
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

/** Build the chat completions URL for a provider. */
function chatUrl(provider) {
  const base = providerBaseUrl(provider);
  // Ollama exposes OpenAI-compat at /v1/chat/completions as well.
  return `${base}/v1/chat/completions`;
}

/**
 * List models for a provider.
 * For kind 'ollama' we prefer the native /api/tags (richer metadata);
 * for 'openai' (and as a fallback) we use /v1/models.
 * @returns {Promise<Array<{id:string, name:string, size?:string|number, parameterSize?:string, family?:string}>>}
 */
async function listModels(provider, { timeoutMs = 8000 } = {}) {
  const base = providerBaseUrl(provider);
  const headers = { accept: 'application/json' };
  const key = provider.apiKey;
  if (key) headers.authorization = `Bearer ${key}`;

  if (provider.kind === 'ollama') {
    try {
      const res = await fetch(`${base}/api/tags`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const data = await res.json();
        const out = [];
        for (const m of data.models || []) {
          out.push({
            id: m.name,
            name: m.name,
            family: m.family,
            size: m.size,
            parameterSize: m.parameter_size,
            modifiedAt: m.modified_at,
          });
        }
        if (out.length) return out;
      }
    } catch { /* fall through to /v1/models */ }
  }

  const res = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw Object.assign(new Error(`Failed to list models: HTTP ${res.status} ${res.statusText}`), {
      status: res.status,
    });
  }
  const data = await res.json();
  const arr = Array.isArray(data) ? data : data.data || [];
  return arr
    .map((m) => ({
      id: m.id || m.name,
      name: m.name || m.id,
      family: m.family,
      size: m.size,
    }))
    .filter((m) => m.id);
}

/**
 * Check provider health.
 * @returns {Promise<{ok:boolean, latencyMs:number, error?:string, version?:string}>}
 */
async function pingProvider(provider, { timeoutMs = 4000 } = {}) {
  const start = Date.now();
  const base = providerBaseUrl(provider);
  const headers = { accept: 'application/json' };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  try {
    let res;
    if (provider.kind === 'ollama') {
      res = await fetch(`${base}/api/version`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } else {
      res = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    }
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    }
    let version;
    try {
      const data = await res.json();
      version = data.version || (data.data && data.data.length ? data.data[0].id : null) || null;
    } catch { /* no body */ }
    return { ok: true, latencyMs, version };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err && err.message ? err.message : 'unreachable' };
  }
}

/**
 * Parse an SSE stream from a fetch Response, invoking onEvent for each
 * parsed `data:` payload. Handles multi-line data, comments, and [DONE].
 * The last non-null JSON payload is returned.
 */
async function readSseStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let lastPayload = null;

  const handleLine = (line) => {
    line = line.replace(/\r$/, '');
    if (!line || line.startsWith(':')) return; // comment / keepalive
    if (!line.startsWith('data:')) return; // ignore event:/id: fields
    let data = line.slice(5).trim();
    if (data === '[DONE]') return;
    try {
      const obj = JSON.parse(data);
      lastPayload = obj;
      onEvent(obj);
    } catch {
      // Non-JSON data line (some servers send plain text deltas).
      if (data) onEvent({ choices: [{ delta: { content: data } }] });
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    }
    if (buffer) handleLine(buffer);
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return lastPayload;
}

/**
 * Send a chat completion request.
 *
 * @param {object} p
 * @param {object} p.provider   provider def {baseUrl, apiKey, kind}
 * @param {string} p.model      model id
 * @param {Array}  p.messages   OpenAI-format messages
 * @param {number} [p.temperature]
 * @param {number} [p.topP]
 * @param {number} [p.maxTokens]
 * @param {number} [p.frequencyPenalty]
 * @param {number} [p.presencePenalty]
 * @param {Array}  [p.tools]    OpenAI-format tools
 * @param {string|object} [p.toolChoice]
 * @param {boolean} [p.stream]  stream via SSE (default true)
 * @param {AbortSignal} [p.signal]
 * @param {number} [p.timeoutMs]
 * @param {(ev:object)=>void} [p.onEvent]
 * @returns {Promise<{content:string, toolCalls:object[], finishReason:string, usage:object|null, raw?:object}>}
 */
async function chatCompletion(p) {
  const {
    provider, model, messages,
    temperature, topP, maxTokens, frequencyPenalty, presencePenalty,
    tools, toolChoice,
    stream = true, signal, timeoutMs = 0, onEvent,
  } = p;

  const body = { model, messages, stream };
  if (typeof temperature === 'number') body.temperature = temperature;
  if (typeof topP === 'number') body.top_p = topP;
  if (typeof maxTokens === 'number' && maxTokens > 0) body.max_tokens = maxTokens;
  if (typeof frequencyPenalty === 'number') body.frequency_penalty = frequencyPenalty;
  if (typeof presencePenalty === 'number') body.presence_penalty = presencePenalty;
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }
  // Ollama-specific: stream options in body for usage reporting.
  if (stream && provider.kind === 'ollama') body.stream_options = { include_usage: true };

  const headers = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
  };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  const fetchOpts = { method: 'POST', headers, body: JSON.stringify(body) };
  const signals = [];
  if (signal) signals.push(signal);
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  fetchOpts.signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  let res;
  try {
    res = await fetch(chatUrl(provider), fetchOpts);
  } catch (err) {
    if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
    throw Object.assign(new Error(`Request to ${providerBaseUrl(provider)} failed: ${err && err.message ? err.message : err}`), { status: 502 });
  }

  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch { /* ignore */ }
    const msg = `LLM HTTP ${res.status}: ${truncate(text, 500)}`;
    const e = new Error(msg);
    e.status = res.status;
    e.body = text;
    throw e;
  }

  if (!stream) {
    const data = await res.json();
    const choice = (data.choices || [])[0] || {};
    const msg = choice.message || {};
    return {
      content: msg.content || '',
      toolCalls: normalizeToolCalls(msg.tool_calls),
      finishReason: choice.finish_reason || 'stop',
      usage: data.usage || null,
      raw: data,
    };
  }

  // Streaming path
  let content = '';
  const toolCalls = [];
  const pendingToolCalls = new Map(); // index -> accumulated tool call
  let finishReason = null;
  let usage = null;
  let gotAny = false;

  const emit = onEvent || (() => {});
  const onPayload = (obj) => {
    gotAny = true;
    if (obj.usage) usage = obj.usage;
    const choice = (obj.choices || [])[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      emit({ type: 'delta', content: delta.content });
    }
    if (typeof delta.reasoning === 'string' && delta.reasoning) {
      emit({ type: 'reasoning', content: delta.reasoning });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : toolCalls.length + pendingToolCalls.size;
        let acc = pendingToolCalls.get(idx);
        if (!acc) {
          acc = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
          pendingToolCalls.set(idx, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.type) acc.type = tc.type;
        if (tc.function) {
          if (tc.function.name) acc.function.name += tc.function.name;
          if (tc.function.arguments) acc.function.arguments += tc.function.arguments;
        }
      }
    }
  };

  const lastPayload = await readSseStream(res, onPayload);

  // Flush pending tool calls in index order.
  const indexes = [...pendingToolCalls.keys()].sort((a, b) => a - b);
  for (const idx of indexes) {
    const tc = pendingToolCalls.get(idx);
    if (!tc.id) tc.id = `call_${idx}_${Date.now().toString(36)}`;
    tc.function.arguments = tc.function.arguments || '{}';
    toolCalls.push(tc);
    emit({ type: 'tool_call', toolCall: tc });
  }
  if (usage) emit({ type: 'usage', usage });
  if (!gotAny && lastPayload) {
    // Some servers send a single JSON blob instead of SSE.
    const choice = (lastPayload.choices || [])[0] || {};
    const msg = choice.message || {};
    content = content || msg.content || '';
    if (!toolCalls.length) {
      for (const tc of normalizeToolCalls(msg.tool_calls)) emit({ type: 'tool_call', toolCall: tc });
    }
    if (lastPayload.usage) { usage = lastPayload.usage; emit({ type: 'usage', usage }); }
    finishReason = finishReason || choice.finish_reason || 'stop';
  }

  if (content) emit({ type: 'done', finishReason: finishReason || 'stop' });

  return { content, toolCalls, finishReason: finishReason || (gotAny ? 'stop' : 'unknown'), usage };
}

/** Normalize OpenAI tool_calls (already complete) into our internal shape. */
function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  const out = [];
  for (const tc of toolCalls) {
    if (!tc || !tc.function) continue;
    let args = tc.function.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args || '{}'); } catch { args = { __raw: args }; }
    }
    out.push({
      id: tc.id || `call_${out.length}`,
      type: 'function',
      function: { name: tc.function.name, arguments: args || {} },
    });
  }
  return out;
}

/**
 * Execute a non-streamed completion and return the full result (used by
 * server-side features such as auto-title generation).
 */
async function complete(provider, model, messages, opts = {}) {
  return chatCompletion({ ...opts, provider, model, messages, stream: false });
}

module.exports = {
  providerBaseUrl,
  listModels,
  pingProvider,
  chatCompletion,
  complete,
  normalizeToolCalls,
};
