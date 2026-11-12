'use strict';
/**
 * WebGUI single-page app — vanilla JS, no build step, no dependencies.
 * Talks only to the HTTP API documented in /API.md (same origin).
 */
(function () {
  // ---------------------------------------------------------------- helpers
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString();
  }

  function fmtRel(ts) {
    if (!ts) return '';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  // ---------------------------------------------------------------- toasts
  function toast(msg, kind) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => { el.remove(); }, 6000);
    el.addEventListener('click', () => el.remove());
  }

  // ---------------------------------------------------------------- API layer
  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      signal: opts.signal,
    });
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const msg = (data && data.error) || text || ('HTTP ' + res.status);
      if (res.status === 401) showLogin('Session expired — please log in again.');
      throw new ApiError(res.status, msg);
    }
    return data;
  }

  async function apiForm(path, formData, opts) {
    opts = opts || {};
    const res = await fetch(path, {
      method: opts.method || 'POST',
      body: formData,
      credentials: 'same-origin',
      signal: opts.signal,
    });
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const msg = (data && data.error) || text || ('HTTP ' + res.status);
      if (res.status === 401) showLogin('Session expired — please log in again.');
      throw new ApiError(res.status, msg);
    }
    return data;
  }

  function setLoading(btn, on, label) {
    if (!btn) return;
    btn.classList.toggle('loading', !!on);
    btn.disabled = !!on;
    if (on && label !== undefined) btn.dataset._label = btn.textContent;
    if (on && label !== undefined) btn.textContent = label;
    if (!on && btn.dataset._label !== undefined) { btn.textContent = btn.dataset._label; delete btn.dataset._label; }
  }

  // ---------------------------------------------------------------- modal
  let modalCleanup = null;
  function openModal(html, opts) {
    opts = opts || {};
    const root = $('#modalRoot');
    const box = $('#modalBox');
    box.className = 'modal' + (opts.wide ? ' wide' : '');
    box.innerHTML = html;
    root.classList.remove('hidden');
    const close = () => closeModal();
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    modalCleanup = () => { document.removeEventListener('keydown', onKey); };
    $$('[data-close-modal]', root).forEach((el) => el.addEventListener('click', close));
    return box;
  }
  function closeModal() {
    $('#modalRoot').classList.add('hidden');
    $('#modalBox').innerHTML = '';
    if (modalCleanup) { modalCleanup(); modalCleanup = null; }
  }
  function confirmDialog(title, body, confirmLabel) {
    return new Promise((resolve) => {
      const box = openModal(
        '<h3>' + esc(title) + '</h3><p class="muted">' + esc(body) + '</p>' +
        '<div class="modal-actions"><button class="btn" id="cfCancel">Cancel</button>' +
        '<button class="btn danger" id="cfOk">' + esc(confirmLabel || 'Confirm') + '</button></div>'
      );
      $('#cfCancel', box).addEventListener('click', () => { closeModal(); resolve(false); });
      $('#cfOk', box).addEventListener('click', () => { closeModal(); resolve(true); });
    });
  }

  // ---------------------------------------------------------------- markdown-lite
  // Escape HTML first, then render structure. Code fences are extracted
  // before escaping and restored afterwards, so model output can never
  // inject markup.
  function renderMarkdown(src) {
    const text = String(src || '');
    const codeBlocks = [];
    let t = text.replace(/```([^\n`]*)\n([\s\S]*?)(?:```|$)/g, (m, lang, code) => {
      codeBlocks.push({ lang: (lang || '').trim(), code });
      return '\u0000CODE' + (codeBlocks.length - 1) + '\u0000';
    });
    t = esc(t);
    t = t.replace(/`([^`\n]+)`/g, (m, c) => '<code>' + c + '</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    t = t.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

    const lines = t.split('\n');
    let html = '';
    let list = null; // 'ul' | 'ol'
    const closeList = () => { if (list) { html += '</' + list + '>'; list = null; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.indexOf('\u0000CODE') === 0 && line.indexOf('\u0000', 6) > 0) {
        closeList();
        const idx = parseInt(line.slice(5), 10);
        const block = codeBlocks[idx];
        if (block) {
          html += '<pre><code>' + esc(block.code.replace(/\n$/, '')) + '</code></pre>';
          continue;
        }
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); html += '<h' + h[1].length + '>' + h[2] + '</h' + h[1].length + '>'; continue; }
      if (/^\s*---+\s*$/.test(line)) { closeList(); html += '<hr>'; continue; }
      if (/^&gt;\s?/.test(line)) { closeList(); html += '<blockquote>' + line.replace(/^&gt;\s?/, '') + '</blockquote>'; continue; }
      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        const want = ul ? 'ul' : 'ol';
        if (list !== want) { closeList(); html += '<' + want + '>'; list = want; }
        html += '<li>' + (ul ? ul[1] : ol[1]) + '</li>';
        continue;
      }
      if (line.trim() === '') { closeList(); continue; }
      closeList();
      html += '<p>' + line + '</p>';
    }
    closeList();
    html = html.replace(/\u0000CODE(\d+)\u0000/g, (m, idx) => {
      const block = codeBlocks[parseInt(idx, 10)];
      return block ? '<pre><code>' + esc(block.code.replace(/\n$/, '')) + '</code></pre>' : '';
    });
    return html || '<p></p>';
  }

  // ---------------------------------------------------------------- state
  const state = {
    auth: { enabled: false, authenticated: false },
    settings: null,
    providers: [],
    modelsByProvider: {},
    conversations: [],
    currentId: null,
    messages: [], // {role, content, reasoning?, toolCalls?}
    templates: [],
    knowledge: [],
    attachedKnowledge: new Set(),
    chatStreaming: false,
    chatAbort: null,
    view: 'chat',
    memoryRecordsCache: [],
    logTimer: null,
  };

  function defaultChatSettings() {
    const d = (state.settings && state.settings.defaultSettings) || {};
    return {
      temperature: d.temperature != null ? d.temperature : 0.7,
      topP: d.topP != null ? d.topP : 1,
      maxTokens: d.maxTokens != null ? d.maxTokens : 0,
      frequencyPenalty: d.frequencyPenalty != null ? d.frequencyPenalty : 0,
      presencePenalty: d.presencePenalty != null ? d.presencePenalty : 0,
    };
  }

  // ---------------------------------------------------------------- auth
  function showLogin(msg) {
    const overlay = $('#loginOverlay');
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    if (msg) { const e = $('#loginError'); e.textContent = msg; e.classList.remove('hidden'); }
    setTimeout(() => $('#loginPassword').focus(), 50);
  }
  function hideLogin() {
    const overlay = $('#loginOverlay');
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    $('#loginError').classList.add('hidden');
    $('#loginPassword').value = '';
  }

  async function checkAuth() {
    try {
      const st = await api('/api/auth/status');
      state.auth = st;
      if (!st.enabled) { hideLogin(); return true; }
      if (st.authenticated) { hideLogin(); return true; }
      showLogin();
      return false;
    } catch (e) {
      toast('Could not reach the server: ' + e.message, 'error');
      return false;
    }
  }

  // ---------------------------------------------------------------- views
  function showView(name) {
    state.view = name;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $('#sidebar').classList.remove('open');
    if (name === 'providers') loadProviders();
    if (name === 'knowledge') loadKnowledge();
    if (name === 'memory') loadMemory();
    if (name === 'mcp') loadMcp();
    if (name === 'tools') loadTools();
    if (name === 'logs') loadLogs();
    if (name === 'settings') renderSettings();
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
    $('#themeToggle').textContent = theme === 'light' ? '☀️ Light' : '🌙 Dark';
    const sel = $('#settingTheme');
    if (sel) sel.value = theme === 'light' ? 'light' : 'dark';
  }

  // ---------------------------------------------------------------- health
  async function loadHealth() {
    try {
      const h = await api('/api/health');
      $('#healthLine').textContent =
        'v' + (h.version || '?') + ' · up ' + (h.uptimeSec || 0) + 's · ' +
        (h.memory && h.memory.encoder ? h.memory.encoder : 'memory ?') + ' · ' +
        (h.memory ? h.memory.records + ' records' : '');
    } catch (e) {
      $('#healthLine').textContent = 'Server unreachable';
    }
  }

  // ---------------------------------------------------------------- settings
  async function loadSettings() {
    state.settings = await api('/api/settings');
    applyTheme(state.settings.theme || 'dark');
    return state.settings;
  }

  function renderSettings() {
    const s = state.settings;
    if (!s) return;
    $('#settingTheme').value = s.theme || 'dark';
    const d = s.defaultSettings || {};
    $('#settingDefaultModel').value = s.defaultModel || '';
    $('#settingToolsMode').value = s.toolsMode || 'auto';
    $('#settingTemperature').value = d.temperature != null ? d.temperature : 0.7;
    $('#settingTopP').value = d.topP != null ? d.topP : 1;
    $('#settingMaxTokens').value = d.maxTokens != null ? d.maxTokens : 0;
    $('#settingFrequencyPenalty').value = d.frequencyPenalty != null ? d.frequencyPenalty : 0;
    $('#settingPresencePenalty').value = d.presencePenalty != null ? d.presencePenalty : 0;
    syncSliderOutputs('setting');
    const provSel = $('#settingDefaultProvider');
    provSel.innerHTML = '<option value="">— none —</option>' +
      state.providers.map((p) => '<option value="' + esc(p._id) + '"' + (p._id === s.defaultProviderId ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('');
    const memProv = $('#settingMemoryProvider');
    memProv.innerHTML = state.providers.map((p) => '<option value="' + esc(p._id) + '"' + (s.memory && p._id === s.memory.providerId ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('');
    $('#settingMemoryEnabled').checked = !(s.memory && s.memory.enabled === false);
    $('#settingEmbeddingModel').value = (s.memory && s.memory.embeddingModel) || 'nomic-embed-text';
    renderTemplates();
  }

  function syncSliderOutputs(prefix) {
    const map = prefix === 'setting'
      ? [['settingTemperature', 'settingTempOut'], ['settingTopP', 'settingTopPOut'],
         ['settingFrequencyPenalty', 'settingFreqOut'], ['settingPresencePenalty', 'settingPresenceOut']]
      : [['temperatureInput', 'temperatureOut'], ['topPInput', 'topPOut'],
         ['frequencyPenaltyInput', 'frequencyPenaltyOut'], ['presencePenaltyInput', 'presencePenaltyOut']];
    map.forEach(([inpId, outId]) => {
      const inp = document.getElementById(inpId);
      const out = document.getElementById(outId);
      if (inp && out) out.textContent = inp.value;
    });
  }

  async function saveSettings() {
    const btn = $('#settingsSaveBtn');
    setLoading(btn, true, 'Saving…');
    try {
      const body = {
        theme: $('#settingTheme').value,
        defaultProviderId: $('#settingDefaultProvider').value || '',
        defaultModel: $('#settingDefaultModel').value.trim(),
        toolsMode: $('#settingToolsMode').value,
        defaultSettings: {
          temperature: parseFloat($('#settingTemperature').value),
          topP: parseFloat($('#settingTopP').value),
          maxTokens: parseInt($('#settingMaxTokens').value, 10) || 0,
          frequencyPenalty: parseFloat($('#settingFrequencyPenalty').value),
          presencePenalty: parseFloat($('#settingPresencePenalty').value),
        },
        memory: {
          enabled: $('#settingMemoryEnabled').checked,
          providerId: $('#settingMemoryProvider').value || '',
          embeddingModel: $('#settingEmbeddingModel').value.trim() || 'nomic-embed-text',
        },
      };
      state.settings = await api('/api/settings', { method: 'PUT', body });
      applyTheme(state.settings.theme || 'dark');
      toast('Settings saved', 'success');
      await refreshChatSelectors();
    } catch (e) {
      toast('Could not save settings: ' + e.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  }

  // ---------------------------------------------------------------- providers
  async function loadProviders() {
    try {
      state.providers = await api('/api/providers');
    } catch (e) {
      toast('Could not load providers: ' + e.message, 'error');
      state.providers = [];
    }
    renderProviders();
    await refreshChatSelectors();
    if (state.view === 'settings') renderSettings();
  }

  function renderProviders() {
    const list = $('#providerList');
    const empty = $('#providerEmpty');
    if (!state.providers.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    list.innerHTML = state.providers.map((p) => {
      return '<div class="card" data-id="' + esc(p._id) + '">' +
        '<div class="card-head"><div><h4>' + esc(p.name) + '</h4>' +
        '<div class="card-sub">' + esc(p.kind) + ' · ' + esc(p.baseUrl) + ' · ' +
        (p.hasApiKey ? 'API key set' : 'no API key') + ' · ' + (p.enabled ? 'enabled' : 'disabled') + '</div></div>' +
        '<span class="badge ' + (p.enabled ? 'green' : 'grey') + '">' + (p.enabled ? 'enabled' : 'disabled') + '</span></div>' +
        '<div class="card-actions">' +
        '<button class="btn small" data-act="ping">Ping</button>' +
        '<button class="btn small" data-act="models">Models</button>' +
        '<button class="btn small" data-act="edit">Edit</button>' +
        '<button class="btn small danger" data-act="delete">Delete</button>' +
        '<span class="muted small" data-role="status"></span>' +
        '</div></div>';
    }).join('');
    $$('.card', list).forEach((card) => {
      const id = card.dataset.id;
      card.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        const statusEl = $('[data-role="status"]', card);
        if (act === 'ping') return pingProvider(id, statusEl, btn);
        if (act === 'models') return showProviderModels(id);
        if (act === 'edit') return openProviderForm(id);
        if (act === 'delete') return deleteProvider(id);
      });
    });
  }

  async function pingProvider(id, statusEl, btn) {
    setLoading(btn, true, 'Pinging…');
    try {
      const r = await api('/api/providers/' + encodeURIComponent(id) + '/ping');
      statusEl.textContent = r.ok ? ('✓ ' + r.latencyMs + ' ms' + (r.version ? ' · ' + r.version : '')) : ('✗ ' + (r.error || 'unreachable'));
      statusEl.style.color = r.ok ? 'var(--success)' : 'var(--danger)';
    } catch (e) {
      statusEl.textContent = '✗ ' + e.message;
      statusEl.style.color = 'var(--danger)';
    } finally {
      setLoading(btn, false);
    }
  }

  async function showProviderModels(id) {
    const p = state.providers.find((x) => x._id === id);
    try {
      const models = await api('/api/providers/' + encodeURIComponent(id) + '/models');
      state.modelsByProvider[id] = models;
      const rows = models.length
        ? models.map((m) => '<tr><td>' + esc(m.id) + '</td><td>' + esc(m.name || m.id) + '</td><td>' + esc(m.family || '—') + '</td><td>' + esc(m.parameterSize || (m.size != null ? String(m.size) : '—')) + '</td></tr>').join('')
        : '<tr><td colspan="4" class="muted">No models reported by this provider.</td></tr>';
      openModal('<h3>Models — ' + esc(p ? p.name : id) + '</h3>' +
        '<div class="table-wrap"><table class="table"><thead><tr><th>ID</th><th>Name</th><th>Family</th><th>Size</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="modal-actions"><button class="btn" data-close-modal>Close</button></div>');
    } catch (e) {
      toast('Could not list models: ' + e.message, 'error');
    }
  }

  function openProviderForm(id) {
    const p = id ? state.providers.find((x) => x._id === id) : null;
    const box = openModal(
      '<h3>' + (p ? 'Edit provider' : 'Add provider') + '</h3>' +
      '<div class="settings-grid">' +
      '<label class="field"><span>Name *</span><input id="pfName" class="input" type="text" value="' + esc(p ? p.name : '') + '" placeholder="Ollama (local)"></label>' +
      '<label class="field"><span>Kind *</span><select id="pfKind" class="input"><option value="ollama"' + (p && p.kind === 'ollama' ? ' selected' : '') + '>ollama</option><option value="openai"' + (p && p.kind === 'openai' ? ' selected' : '') + '>openai</option></select></label>' +
      '<label class="field span-2"><span>Base URL *</span><input id="pfBaseUrl" class="input" type="text" value="' + esc(p ? p.baseUrl : 'http://localhost:11434') + '" placeholder="http://localhost:11434"></label>' +
      '<label class="field"><span>API key (write-only, leave blank to keep)</span><input id="pfApiKey" class="input" type="password" autocomplete="off" placeholder="••••••••"></label>' +
      '<label class="check"><input id="pfEnabled" type="checkbox"' + (!p || p.enabled ? ' checked' : '') + '> Enabled</label>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn" data-close-modal>Cancel</button>' +
      '<button class="btn primary" id="pfSave">' + (p ? 'Save changes' : 'Create provider') + '</button></div>'
    );
    $('#pfSave', box).addEventListener('click', async () => {
      const btn = $('#pfSave', box);
      const body = {
        name: $('#pfName', box).value.trim(),
        kind: $('#pfKind', box).value,
        baseUrl: $('#pfBaseUrl', box).value.trim(),
        enabled: $('#pfEnabled', box).checked,
      };
      const key = $('#pfApiKey', box).value;
      if (key) body.apiKey = key;
      if (!body.name || !body.baseUrl) { toast('Name and base URL are required.', 'error'); return; }
      setLoading(btn, true, 'Saving…');
      try {
        if (p) await api('/api/providers/' + encodeURIComponent(p._id), { method: 'PUT', body });
        else await api('/api/providers', { method: 'POST', body });
        closeModal();
        toast('Provider saved', 'success');
        await loadProviders();
      } catch (e) {
        toast('Could not save provider: ' + e.message, 'error');
      } finally {
        setLoading(btn, false);
      }
    });
  }

  async function deleteProvider(id) {
    const p = state.providers.find((x) => x._id === id);
    if (!await confirmDialog('Delete provider', 'Delete provider "' + (p ? p.name : id) + '"? Conversations that used it keep working only if another provider is selected.', 'Delete')) return;
    try {
      await api('/api/providers/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('Provider deleted', 'success');
      await loadProviders();
    } catch (e) {
      toast('Could not delete provider: ' + e.message, 'error');
    }
  }

  // ---------------------------------------------------------------- templates
  async function loadTemplates() {
    try {
      state.templates = await api('/api/templates');
    } catch (e) {
      toast('Could not load templates: ' + e.message, 'error');
      state.templates = [];
    }
    const sel = $('#templateSelect');
    sel.innerHTML = '<option value="">＋ Insert template…</option>' +
      state.templates.map((t) => '<option value="' + esc(t._id) + '">' + esc(t.name) + '</option>').join('');
    if (state.view === 'settings') renderTemplates();
  }

  function renderTemplates() {
    const list = $('#templateList');
    const empty = $('#templateEmpty');
    if (!state.templates.length) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    list.innerHTML = state.templates.map((t) =>
      '<div class="card" data-id="' + esc(t._id) + '"><div class="card-head"><div><h4>' + esc(t.name) + '</h4>' +
      '<div class="card-sub">' + esc(t.description || '') + '</div></div></div>' +
      '<pre>' + esc(t.content) + '</pre>' +
      '<div class="card-actions"><button class="btn small" data-act="edit">Edit</button>' +
      '<button class="btn small danger" data-act="delete">Delete</button></div></div>'
    ).join('');
    $$('.card', list).forEach((card) => {
      card.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        if (btn.dataset.act === 'edit') openTemplateForm(card.dataset.id);
        else deleteTemplate(card.dataset.id);
      });
    });
  }

  function openTemplateForm(id) {
    const t = id ? state.templates.find((x) => x._id === id) : null;
    const box = openModal(
      '<h3>' + (t ? 'Edit template' : 'New template') + '</h3>' +
      '<div class="settings-grid">' +
      '<label class="field"><span>Name *</span><input id="tfName" class="input" type="text" value="' + esc(t ? t.name : '') + '"></label>' +
      '<label class="field"><span>Description</span><input id="tfDesc" class="input" type="text" value="' + esc(t ? t.description || '' : '') + '"></label>' +
      '<label class="field span-2"><span>Content *</span><textarea id="tfContent" rows="8">' + esc(t ? t.content : '') + '</textarea></label>' +
      '</div><p class="muted small">Use {{placeholder}} for values the user fills in when inserting.</p>' +
      '<div class="modal-actions"><button class="btn" data-close-modal>Cancel</button>' +
      '<button class="btn primary" id="tfSave">' + (t ? 'Save changes' : 'Create template') + '</button></div>'
    );
    $('#tfSave', box).addEventListener('click', async () => {
      const btn = $('#tfSave', box);
      const body = {
        name: $('#tfName', box).value.trim(),
        description: $('#tfDesc', box).value.trim(),
        content: $('#tfContent', box).value,
      };
      if (!body.name || !body.content) { toast('Name and content are required.', 'error'); return; }
      setLoading(btn, true, 'Saving…');
      try {
        if (t) await api('/api/templates/' + encodeURIComponent(t._id), { method: 'PUT', body });
        else await api('/api/templates', { method: 'POST', body });
        closeModal();
        toast('Template saved', 'success');
        await loadTemplates();
      } catch (e) {
        toast('Could not save template: ' + e.message, 'error');
      } finally {
        setLoading(btn, false);
      }
    });
  }

  async function deleteTemplate(id) {
    const t = state.templates.find((x) => x._id === id);
    if (!await confirmDialog('Delete template', 'Delete template "' + (t ? t.name : id) + '"?', 'Delete')) return;
    try {
      await api('/api/templates/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('Template deleted', 'success');
      await loadTemplates();
    } catch (e) {
      toast('Could not delete template: ' + e.message, 'error');
    }
  }

  // ---------------------------------------------------------------- conversations
  async function loadConversations() {
    $('#convoLoading').classList.remove('hidden');
    try {
      state.conversations = await api('/api/conversations');
    } catch (e) {
      toast('Could not load conversations: ' + e.message, 'error');
      state.conversations = [];
    } finally {
      $('#convoLoading').classList.add('hidden');
    }
    renderConversationList();
  }

  function renderConversationList() {
    const filter = ($('#convoFilter').value || '').toLowerCase();
    const list = $('#convoList');
    const items = state.conversations.filter((c) => !filter || (c.title || '').toLowerCase().includes(filter));
    $('#convoEmpty').classList.toggle('hidden', items.length > 0 || state.conversations.length > 0);
    const sorted = items.slice().sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    list.innerHTML = sorted.map((c) =>
      '<li class="convo-item' + (c._id === state.currentId ? ' active' : '') + '" data-id="' + esc(c._id) + '">' +
      (c.pinned ? '<span class="pin" title="Pinned">📌</span>' : '') +
      '<span class="convo-title">' + esc(c.title || 'Untitled') + '</span>' +
      '<span class="convo-meta">' + (c.messageCount || 0) + '</span>' +
      '<button class="icon-btn" data-act="pin" title="' + (c.pinned ? 'Unpin' : 'Pin') + '">' + (c.pinned ? '📍' : '📌') + '</button>' +
      '<button class="icon-btn" data-act="rename" title="Rename">✏️</button>' +
      '<button class="icon-btn" data-act="delete" title="Delete">🗑</button>' +
      '</li>'
    ).join('');
    $$('.convo-item', list).forEach((el) => {
      el.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        const id = el.dataset.id;
        if (btn) {
          e.stopPropagation();
          if (btn.dataset.act === 'pin') return togglePin(id);
          if (btn.dataset.act === 'rename') return renameConversation(id);
          if (btn.dataset.act === 'delete') return deleteConversation(id);
          return;
        }
        openConversation(id);
      });
    });
  }

  async function togglePin(id) {
    const c = state.conversations.find((x) => x._id === id);
    if (!c) return;
    try {
      await api('/api/conversations/' + encodeURIComponent(id), { method: 'PUT', body: { pinned: !c.pinned } });
      await loadConversations();
    } catch (e) {
      toast('Could not update pin: ' + e.message, 'error');
    }
  }

  async function renameConversation(id) {
    const c = state.conversations.find((x) => x._id === id);
    const box = openModal(
      '<h3>Rename conversation</h3>' +
      '<label class="field"><span>Title</span><input id="rnTitle" class="input" type="text" value="' + esc(c ? c.title : '') + '" maxlength="200"></label>' +
      '<div class="modal-actions"><button class="btn" data-close-modal>Cancel</button>' +
      '<button class="btn primary" id="rnSave">Save</button></div>'
    );
    $('#rnSave', box).addEventListener('click', async () => {
      const title = $('#rnTitle', box).value.trim();
      if (!title) { toast('Title cannot be empty.', 'error'); return; }
      try {
        await api('/api/conversations/' + encodeURIComponent(id), { method: 'PUT', body: { title } });
        closeModal();
        await loadConversations();
        if (id === state.currentId) $('#chatTitle').textContent = title;
      } catch (e) {
        toast('Could not rename: ' + e.message, 'error');
      }
    });
    setTimeout(() => { const i = $('#rnTitle', box); i.focus(); i.select(); }, 50);
  }

  async function deleteConversation(id) {
    const c = state.conversations.find((x) => x._id === id);
    if (!await confirmDialog('Delete conversation', 'Delete "' + (c ? c.title : id) + '" and all its messages? This cannot be undone.', 'Delete')) return;
    try {
      await api('/api/conversations/' + encodeURIComponent(id), { method: 'DELETE' });
      if (id === state.currentId) newChat();
      await loadConversations();
      toast('Conversation deleted', 'success');
    } catch (e) {
      toast('Could not delete conversation: ' + e.message, 'error');
    }
  }

  function newChat() {
    if (state.chatStreaming && state.chatAbort) state.chatAbort.abort();
    state.currentId = null;
    state.messages = [];
    state.attachedKnowledge = new Set();
    $('#chatTitle').textContent = 'New conversation';
    $('#chatMeta').textContent = 'Pick a provider and model, then say hello.';
    renderMessages();
    renderAttachList();
    syncChatSettingsPanel(defaultChatSettings(), '');
    refreshChatSelectors();
    renderConversationList();
    $('#composerInput').focus();
  }

  async function openConversation(id) {
    if (state.chatStreaming) { toast('Wait for the current reply to finish (or press Stop) before switching.', 'error'); return; }
    try {
      const convo = await api('/api/conversations/' + encodeURIComponent(id));
      state.currentId = convo._id;
      state.messages = (convo.messages || []).map((m) => ({
        role: m.role, content: m.content || '', reasoning: m.reasoning, toolCalls: m.toolCalls,
      }));
      state.attachedKnowledge = new Set();
      $('#chatTitle').textContent = convo.title || 'Untitled';
      $('#chatMeta').textContent = fmtTime(convo.updatedAt) + (convo.model ? ' · ' + convo.model : '');
      syncChatSettingsPanel(convo.settings || defaultChatSettings(), convo.systemPrompt || '');
      renderMessages();
      renderAttachList();
      await refreshChatSelectors(convo.providerId, convo.model);
      renderConversationList();
      showView('chat');
      scrollMessagesToBottom();
    } catch (e) {
      toast('Could not open conversation: ' + e.message, 'error');
    }
  }

  // ---------------------------------------------------------------- chat selectors & settings
  async function refreshChatSelectors(preferProvider, preferModel) {
    const provSel = $('#providerSelect');
    const modelSel = $('#modelSelect');
    const enabled = state.providers.filter((p) => p.enabled);
    const list = enabled.length ? enabled : state.providers;
    const fallbackProvider = (state.settings && state.settings.defaultProviderId) || (list[0] && list[0]._id) || '';
    const providerId = preferProvider || (provSel.value && list.some((p) => p._id === provSel.value) ? provSel.value : fallbackProvider);
    provSel.innerHTML = list.map((p) =>
      '<option value="' + esc(p._id) + '"' + (p._id === providerId ? ' selected' : '') + '>' + esc(p.name) + ' (' + esc(p.kind) + ')</option>'
    ).join('');
    if (!list.length) { modelSel.innerHTML = '<option value="">— no provider —</option>'; return; }
    let models = state.modelsByProvider[providerId];
    if (!models) {
      try {
        models = await api('/api/providers/' + encodeURIComponent(providerId) + '/models');
        state.modelsByProvider[providerId] = models;
      } catch (e) {
        models = [];
      }
    }
    const fallbackModel = preferModel || (state.settings && state.settings.defaultModel) || '';
    const options = models.map((m) => m.id);
    const selected = options.includes(fallbackModel) ? fallbackModel : (options[0] || fallbackModel);
    if (selected && !options.includes(selected)) options.unshift(selected);
    modelSel.innerHTML = options.length
      ? options.map((id) => '<option value="' + esc(id) + '"' + (id === selected ? ' selected' : '') + '>' + esc(id) + '</option>').join('')
      : '<option value="' + esc(fallbackModel) + '">' + esc(fallbackModel || '— no models —') + '</option>';
  }

  function chatSettingsFromPanel() {
    return {
      temperature: parseFloat($('#temperatureInput').value),
      topP: parseFloat($('#topPInput').value),
      maxTokens: parseInt($('#maxTokensInput').value, 10) || 0,
      frequencyPenalty: parseFloat($('#frequencyPenaltyInput').value),
      presencePenalty: parseFloat($('#presencePenaltyInput').value),
    };
  }

  function syncChatSettingsPanel(settings, systemPrompt) {
    $('#temperatureInput').value = settings.temperature != null ? settings.temperature : 0.7;
    $('#topPInput').value = settings.topP != null ? settings.topP : 1;
    $('#maxTokensInput').value = settings.maxTokens != null ? settings.maxTokens : 0;
    $('#frequencyPenaltyInput').value = settings.frequencyPenalty != null ? settings.frequencyPenalty : 0;
    $('#presencePenaltyInput').value = settings.presencePenalty != null ? settings.presencePenalty : 0;
    $('#systemPromptInput').value = systemPrompt || '';
    $('#toolsModeSelect').value = (state.settings && state.settings.toolsMode) || 'auto';
    [['temperature', 'temperatureOut'], ['topP', 'topPOut'], ['frequencyPenalty', 'frequencyPenaltyOut'], ['presencePenalty', 'presencePenaltyOut']].forEach(([n, o]) => {
      const inp = $('#' + n + 'Input');
      const out = $('#' + o);
      if (inp && out) out.textContent = inp.value;
    });
  }

  async function saveChatSettings() {
    if (!state.currentId) { toast('Chat settings are applied to the next message; start a conversation to save them with it.', 'success'); return; }
    const btn = $('#saveChatSettingsBtn');
    setLoading(btn, true, 'Saving…');
    try {
      await api('/api/conversations/' + encodeURIComponent(state.currentId), {
        method: 'PUT',
        body: { systemPrompt: $('#systemPromptInput').value, settings: chatSettingsFromPanel() },
      });
      toast('Chat settings saved', 'success');
    } catch (e) {
      toast('Could not save chat settings: ' + e.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  }

  function renderAttachList() {
    const box = $('#knowledgeAttachList');
    if (!state.knowledge.length) {
      box.innerHTML = '<span class="muted small">No knowledge documents yet — upload some in the Knowledge section.</span>';
      return;
    }
    box.innerHTML = state.knowledge.map((d) =>
      '<label class="check"><input type="checkbox" data-doc="' + esc(d.id) + '"' + (state.attachedKnowledge.has(d.id) ? ' checked' : '') + '> ' + esc(d.title) + '</label>'
    ).join('');
    $$('input[type="checkbox"]', box).forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) state.attachedKnowledge.add(cb.dataset.doc);
        else state.attachedKnowledge.delete(cb.dataset.doc);
      });
    });
  }

  // ---------------------------------------------------------------- chat rendering
  function scrollMessagesToBottom() {
    const m = $('#messages');
    m.scrollTop = m.scrollHeight;
  }

  function messageEl(msg) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (msg.role === 'user' ? 'user' : 'assistant');
    wrap.innerHTML =
      '<div class="msg-role">' + esc(msg.role === 'user' ? 'You' : msg.role === 'system' ? 'System' : 'Assistant') + '</div>' +
      '<div class="msg-body"></div>';
    const body = $('.msg-body', wrap);
    if (msg.role === 'assistant' && msg.reasoning) {
      const det = document.createElement('details');
      det.className = 'reasoning';
      det.innerHTML = '<summary>Reasoning</summary>';
      const div = document.createElement('div');
      div.innerHTML = renderMarkdown(msg.reasoning);
      det.appendChild(div);
      body.appendChild(det);
    }
    const contentDiv = document.createElement('div');
    contentDiv.innerHTML = renderMarkdown(msg.content || '');
    body.appendChild(contentDiv);
    if (msg.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length) {
      msg.toolCalls.forEach((tc) => {
        const tb = document.createElement('div');
        tb.className = 'tool-block';
        tb.innerHTML = '<div class="tool-name">🔧 ' + esc(tc.function ? tc.function.name : 'tool') + '</div>' +
          '<pre>' + esc(typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments || {}, null, 2)) + '</pre>';
        body.appendChild(tb);
      });
    }
    return { wrap, body, contentDiv };
  }

  function renderMessages() {
    const box = $('#messages');
    box.innerHTML = '';
    $('#chatEmpty').classList.toggle('hidden', state.messages.length > 0);
    state.messages.forEach((m) => {
      if (m.role === 'system') return;
      box.appendChild(messageEl(m).wrap);
    });
    scrollMessagesToBottom();
  }

  // ---------------------------------------------------------------- chat send (SSE)
  async function sendChat() {
    if (state.chatStreaming) return;
    const input = $('#composerInput');
    const text = input.value.trim();
    if (!text) return;
    const providerId = $('#providerSelect').value;
    const model = $('#modelSelect').value;
    if (!providerId || !model) { toast('Pick a provider and a model first.', 'error'); return; }
    input.value = '';
    autoGrow(input);

    const userMsg = { role: 'user', content: text };
    state.messages.push(userMsg);
    renderMessages();
    $('#chatEmpty').classList.add('hidden');

    const assistantMsg = { role: 'assistant', content: '', reasoning: '', toolCalls: [] };
    const { wrap, body, contentDiv } = messageEl(assistantMsg);
    wrap.classList.add('streaming');
    body.insertAdjacentHTML('beforeend', '<span class="typing" aria-label="thinking"></span>');
    $('#messages').appendChild(wrap);
    scrollMessagesToBottom();

    const reasoningDet = document.createElement('details');
    reasoningDet.className = 'reasoning hidden';
    reasoningDet.innerHTML = '<summary>Reasoning</summary><div></div>';
    body.insertBefore(reasoningDet, contentDiv);
    const toolBox = document.createElement('div');
    body.appendChild(toolBox);
    const metaLine = document.createElement('div');
    metaLine.className = 'msg-meta';
    body.appendChild(metaLine);

    state.chatStreaming = true;
    $('#sendBtn').disabled = true;
    $('#stopBtn').classList.remove('hidden');
    const abort = new AbortController();
    state.chatAbort = abort;

    let streamContent = '';
    let streamReasoning = '';
    let renderScheduled = false;
    const rerender = () => {
      if (renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(() => {
        renderScheduled = false;
        contentDiv.innerHTML = renderMarkdown(streamContent);
        if (streamReasoning) {
          reasoningDet.classList.remove('hidden');
          $('div', reasoningDet).innerHTML = renderMarkdown(streamReasoning);
        }
        scrollMessagesToBottom();
      });
    };

    const payload = {
      conversationId: state.currentId || undefined,
      provider: providerId,
      model,
      messages: state.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content || '' })),
      settings: chatSettingsFromPanel(),
      systemPrompt: $('#systemPromptInput').value.trim() || undefined,
      toolsMode: $('#toolsModeSelect').value,
      knowledgeIds: Array.from(state.attachedKnowledge),
      stream: true,
    };

    const finish = (finalContent, extra) => {
      state.chatStreaming = false;
      state.chatAbort = null;
      $('#sendBtn').disabled = false;
      $('#stopBtn').classList.add('hidden');
      wrap.classList.remove('streaming');
      const typing = $('.typing', body);
      if (typing) typing.remove();
      assistantMsg.content = finalContent;
      assistantMsg.reasoning = streamReasoning || undefined;
      if (extra && extra.usage) {
        const u = extra.usage;
        metaLine.textContent = [
          extra.finishReason ? 'finish: ' + extra.finishReason : '',
          u.prompt_tokens != null ? u.prompt_tokens + ' prompt tokens' : '',
          u.completion_tokens != null ? u.completion_tokens + ' completion tokens' : '',
          extra.iterations != null ? extra.iterations + ' tool iteration(s)' : '',
          extra.textFallback ? 'text tool protocol' : '',
        ].filter(Boolean).join(' · ');
      }
      if (extra && extra.toolCalls) assistantMsg.toolCalls = extra.toolCalls;
    };

    let doneEvent = null;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
        signal: abort.signal,
      });
      const contentType = res.headers.get('content-type') || '';
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const d = await res.json(); if (d && d.error) msg = d.error; } catch { /* keep default */ }
        throw new Error(msg);
      }
      if (!contentType.includes('text/event-stream')) {
        // Defensive: server answered JSON instead of SSE.
        const data = await res.json();
        streamContent = data.content || '';
        contentDiv.innerHTML = renderMarkdown(streamContent);
        doneEvent = data;
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const handleEvent = (ev) => {
          if (!ev || typeof ev !== 'object') return;
          if (ev.type === 'delta' && typeof ev.content === 'string') {
            streamContent += ev.content;
            rerender();
          } else if (ev.type === 'reasoning' && typeof ev.content === 'string') {
            streamReasoning += ev.content;
            rerender();
          } else if (ev.type === 'tool_call') {
            const tb = document.createElement('div');
            tb.className = 'tool-block';
            tb.innerHTML = '<div class="tool-name">🔧 ' + esc(ev.toolId || 'tool') + '</div>' +
              '<pre>' + esc(JSON.stringify(ev.args || {}, null, 2)) + '</pre>';
            toolBox.appendChild(tb);
            scrollMessagesToBottom();
          } else if (ev.type === 'tool_result') {
            const tb = document.createElement('div');
            tb.className = 'tool-block';
            tb.innerHTML = '<div class="tool-name">↩ ' + esc(ev.toolId || 'tool') + (ev.isError ? ' — error' : '') + (ev.durationMs != null ? ' · ' + ev.durationMs + ' ms' : '') + '</div>' +
              '<pre>' + esc(String(ev.content || '')) + '</pre>';
            toolBox.appendChild(tb);
            scrollMessagesToBottom();
          } else if (ev.type === 'notice') {
            const n = document.createElement('div');
            n.className = 'msg-meta';
            n.textContent = 'ℹ️ ' + (ev.message || '');
            toolBox.appendChild(n);
          } else if (ev.type === 'done') {
            doneEvent = ev;
          } else if (ev.type === 'error') {
            throw new Error(ev.message || 'Model error');
          } else if (ev.type === 'aborted') {
            metaLine.textContent = 'Aborted.';
          }
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            chunk.split('\n').forEach((line) => {
              if (line.startsWith('data:')) {
                const payloadText = line.slice(5).trim();
                if (payloadText === '[DONE]') return;
                try { handleEvent(JSON.parse(payloadText)); } catch { /* ignore malformed lines */ }
              }
            });
          }
        }
        if (buf.trim()) {
          buf.split('\n').forEach((line) => {
            if (line.startsWith('data:')) {
              try { handleEvent(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ }
            }
          });
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        metaLine.textContent = 'Aborted by user.';
      } else {
        streamContent = streamContent || '';
        const errDiv = document.createElement('div');
        errDiv.className = 'msg-error';
        errDiv.textContent = 'Error: ' + (e.message || e);
        body.appendChild(errDiv);
        toast('Chat failed: ' + (e.message || e), 'error');
      }
    } finally {
      // Finalize: prefer the server's content when the done event carried it.
      const finalContent = streamContent;
      state.messages.push(assistantMsg);
      finish(finalContent, doneEvent || undefined);
      contentDiv.innerHTML = renderMarkdown(finalContent);
      if (doneEvent && (doneEvent.conversationId || doneEvent.id)) {
        const convId = doneEvent.conversationId || doneEvent.id;
        state.currentId = convId;
        if (doneEvent.title) $('#chatTitle').textContent = doneEvent.title;
        $('#chatMeta').textContent = (model || '') + (doneEvent.finishReason ? ' · finish: ' + doneEvent.finishReason : '');
        // Persist the panel's chat settings with the conversation.
        try {
          await api('/api/conversations/' + encodeURIComponent(convId), {
            method: 'PUT',
            body: { systemPrompt: $('#systemPromptInput').value, settings: chatSettingsFromPanel() },
          });
        } catch { /* non-fatal */ }
        loadConversations();
      }
      scrollMessagesToBottom();
    }
  }

  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 220) + 'px';
  }

  // ---------------------------------------------------------------- knowledge
  async function loadKnowledge() {
    try {
      state.knowledge = await api('/api/knowledge');
    } catch (e) {
      toast('Could not load knowledge base: ' + e.message, 'error');
      state.knowledge = [];
    }
    renderKnowledge();
    renderAttachList();
  }

  function renderKnowledge() {
    const list = $('#knowledgeList');
    const empty = $('#knowledgeEmpty');
    if (!state.knowledge.length) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    list.innerHTML = state.knowledge.map((d) =>
      '<div class="card" data-id="' + esc(d.id) + '"><div class="card-head"><div><h4>' + esc(d.title) + '</h4>' +
      '<div class="card-sub">' + esc(d.source || 'no source') + ' · ' + (d.charCount || 0).toLocaleString() + ' chars · ' + (d.chunkCount || 0) + ' chunks · ' + esc(fmtTime(d.created)) + '</div></div></div>' +
      '<div class="card-actions"><button class="btn small" data-act="view">View</button>' +
      '<button class="btn small" data-act="attach">Attach to chat</button>' +
      '<button class="btn small danger" data-act="delete">Delete</button></div></div>'
    ).join('');
    $$('.card', list).forEach((card) => {
      card.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = card.dataset.id;
        if (btn.dataset.act === 'view') return viewKnowledgeDoc(id);
        if (btn.dataset.act === 'attach') {
          state.attachedKnowledge.add(id);
          renderAttachList();
          showView('chat');
          toast('Document attached to this chat. It will be used for retrieval on the next message.', 'success');
        }
        if (btn.dataset.act === 'delete') return deleteKnowledgeDoc(id);
      });
    });
  }

  async function viewKnowledgeDoc(id) {
    try {
      const doc = await api('/api/knowledge/' + encodeURIComponent(id));
      openModal('<h3>' + esc(doc.title) + '</h3>' +
        '<p class="muted small">' + esc(doc.source || '') + ' · ' + (doc.charCount || 0).toLocaleString() + ' chars · ' + (doc.chunkCount || 0) + ' chunks</p>' +
        '<pre style="max-height:55vh;overflow:auto;white-space:pre-wrap">' + esc(doc.content || '') + '</pre>' +
        '<div class="modal-actions"><button class="btn" data-close-modal>Close</button></div>', { wide: true });
    } catch (e) {
      toast('Could not load document: ' + e.message, 'error');
    }
  }

  async function deleteKnowledgeDoc(id) {
    const d = state.knowledge.find((x) => x.id === id);
    if (!await confirmDialog('Delete document', 'Delete "' + (d ? d.title : id) + '" from the knowledge base? Its GyroMem memory records are deleted too.', 'Delete')) return;
    try {
      await api('/api/knowledge/' + encodeURIComponent(id), { method: 'DELETE' });
      state.attachedKnowledge.delete(id);
      toast('Document deleted', 'success');
      await loadKnowledge();
      if (state.view === 'memory') loadMemory();
    } catch (e) {
      toast('Could not delete document: ' + e.message, 'error');
    }
  }

  async function uploadKnowledgeJson(btn) {
    const title = $('#kbTitle').value.trim();
    const source = $('#kbSource').value.trim();
    const content = $('#kbContent').value;
    if (!title) { toast('Title is required.', 'error'); return; }
    if (!content.trim()) { toast('Content is empty.', 'error'); return; }
    setLoading(btn, true, 'Uploading…');
    try {
      const res = await api('/api/knowledge', { method: 'POST', body: { title, content, source } });
      toast('Uploaded "' + res.title + '" — indexed ' + (res.indexed || 0) + ' chunk(s) into Memory.', 'success');
      $('#kbTitle').value = ''; $('#kbSource').value = ''; $('#kbContent').value = '';
      await loadKnowledge();
    } catch (e) {
      toast('Upload failed: ' + e.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  }

  async function uploadKnowledgeFile(btn) {
    const input = $('#kbFileInput');
    const file = input.files && input.files[0];
    if (!file) { toast('Choose a text file first.', 'error'); return; }
    const fd = new FormData();
    fd.append('file', file);
    const title = $('#kbTitle').value.trim();
    if (title) fd.append('title', title);
    const source = $('#kbSource').value.trim();
    if (source) fd.append('source', source);
    setLoading(btn, true, 'Uploading…');
    try {
      const res = await apiForm('/api/knowledge', fd);
      toast('Uploaded "' + res.title + '" — indexed ' + (res.indexed || 0) + ' chunk(s) into Memory.', 'success');
      input.value = '';
      await loadKnowledge();
    } catch (e) {
      toast('Upload failed: ' + e.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  }

  async function searchKnowledge() {
    const q = $('#kbSearchInput').value.trim();
    const box = $('#kbSearchResults');
    if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = '<div class="card"><span class="muted">Searching…</span></div>';
    try {
      const results = await api('/api/knowledge/search?q=' + encodeURIComponent(q) + '&k=8');
      if (!results.length) {
        box.innerHTML = '<div class="card"><span class="muted">No results for "' + esc(q) + '".</span></div>';
        return;
      }
      box.innerHTML = results.map((r) =>
        '<div class="card"><div class="card-head"><div><h4>' + esc(r.docTitle) + '</h4>' +
        '<div class="card-sub">chunk ' + (r.chunkIndex != null ? r.chunkIndex : '?') + ' · score ' + (typeof r.score === 'number' ? r.score.toFixed(3) : '—') +
        ' · retrieval: ' + esc(r.retrieval || '—') + '</div></div>' +
        (r.authority ? '<span class="badge blue">origin=' + esc(r.authority.origin) + ' · act=' + esc(r.authority.actClass) + '</span>' : '') + '</div>' +
        '<p style="margin-top:8px">' + esc(r.chunk) + '</p>' +
        '<div class="card-sub" style="margin-top:6px">' +
        (typeof r.lambda === 'number' ? 'λ ' + r.lambda.toFixed(2) + ' · ' : '') +
        (typeof r.availability === 'number' ? 'availability ' + r.availability.toFixed(2) : '') + '</div></div>'
      ).join('');
    } catch (e) {
      box.innerHTML = '<div class="card"><span class="error-text">Search failed: ' + esc(e.message) + '</span></div>';
    }
  }

  // ---------------------------------------------------------------- memory
  async function loadMemory() {
    const [stats, records] = await Promise.all([
      api('/api/memory/stats').catch((e) => { toast('Could not load memory stats: ' + e.message, 'error'); return null; }),
      loadMemoryRecords().catch((e) => { toast('Could not load memory records: ' + e.message, 'error'); return []; }),
    ]);
    if (stats) renderMemoryStats(stats);
    if (records) { state.memoryRecordsCache = records; renderMemoryTable(); }
    loadHealth();
  }

  function renderMemoryStats(s) {
    $('#memoryStats').innerHTML =
      statCard('Encoder', esc(s.encoder ? s.encoder.kind + ' / ' + s.encoder.model : '—'), 'active embedding model') +
      statCard('Records', String(s.records), s.live + ' live') +
      statCard('Live', String(s.live), 'available for retrieval') +
      statCard('Quarantined', String(s.quarantined), 'held by the immune system') +
      statCard('Flagged', String(s.flagged), 'undetermined, awaiting review') +
      statCard('Deleted', String(s.deleted), 'support-closure removed') +
      statCard('Ledger entries', String(s.ledgerEntries), 'hash-chained audit log');
    const badge = $('#memoryNavBadge');
    const attention = (s.quarantined || 0) + (s.flagged || 0);
    badge.classList.toggle('hidden', !attention);
    badge.textContent = attention ? String(attention) : '';
  }

  function statCard(label, value, sub) {
    return '<div class="stat"><div class="stat-label">' + esc(label) + '</div><div class="stat-value">' + esc(value) + '</div><div class="stat-sub">' + esc(sub || '') + '</div></div>';
  }

  async function loadMemoryRecords() {
    const status = $('#memoryStatusFilter').value;
    const limit = $('#memoryLimitSelect').value;
    const q = status ? '?status=' + encodeURIComponent(status) + '&limit=' + encodeURIComponent(limit) : '?limit=' + encodeURIComponent(limit);
    return api('/api/memory/records' + q);
  }

  function filteredMemoryRecords() {
    const flaggedOnly = $('#memoryFlaggedOnly').checked;
    const needle = ($('#memorySearchInput').value || '').toLowerCase();
    return state.memoryRecordsCache.filter((r) => {
      if (flaggedOnly && !r.flagged) return false;
      if (needle && !(r.content || '').toLowerCase().includes(needle)) return false;
      return true;
    });
  }

  function statusBadge(r) {
    if (r.status === 'live' && r.flagged) return '<span class="badge blue">flagged</span>';
    if (r.status === 'live') return '<span class="badge green">live</span>';
    if (r.status === 'quarantined') return '<span class="badge amber">quarantined</span>';
    if (r.status === 'deleted') return '<span class="badge grey">deleted</span>';
    return '<span class="badge">' + esc(r.status) + '</span>';
  }

  function renderMemoryTable() {
    const rows = filteredMemoryRecords();
    const body = $('#memoryTableBody');
    $('#memoryEmpty').classList.toggle('hidden', rows.length > 0);
    body.innerHTML = rows.map((r) => {
      const lam = typeof r.lambda === 'number' ? r.lambda : 0;
      const av = typeof r.availability === 'number' ? r.availability : 0;
      return '<tr data-id="' + esc(r.id) + '">' +
        '<td class="truncate-cell" title="' + esc(r.content || '') + '">' + esc(truncate(r.content || '', 120)) + '</td>' +
        '<td>' + esc(r.origin) + '</td>' +
        '<td><span class="badge ' + (r.actClass === 'act' ? 'red' : r.actClass === 'inform' ? 'blue' : 'grey') + '">' + esc(r.actClass) + '</span></td>' +
        '<td><span class="meter' + (lam >= 0.6 ? ' good' : lam < 0.3 ? ' warn' : '') + '"><i style="width:' + Math.round(lam * 100) + '%"></i></span><span class="meter-val">' + lam.toFixed(2) + '</span></td>' +
        '<td><span class="meter' + (av >= 0.6 ? ' good' : av < 0.3 ? ' warn' : '') + '"><i style="width:' + Math.round(av * 100) + '%"></i></span><span class="meter-val">' + av.toFixed(2) + '</span></td>' +
        '<td>' + (r.usage || 0) + '</td>' +
        '<td>' + statusBadge(r) + '</td>' +
        '<td class="muted small">' + esc(fmtRel(r.updated)) + '</td>' +
        '<td><button class="btn small" data-act="details">Details</button></td>' +
        '</tr>';
    }).join('');
    $$('tr[data-id]', body).forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="details"]')) openRecordModal(tr.dataset.id);
      });
    });
  }

  function kvRows(obj) {
    return Object.entries(obj || {}).map(([k, v]) =>
      '<dt>' + esc(k) + '</dt><dd>' + esc(typeof v === 'object' ? JSON.stringify(v) : String(v)) + '</dd>'
    ).join('');
  }

  async function openRecordModal(id) {
    let rec;
    try {
      rec = await api('/api/memory/records/' + encodeURIComponent(id));
    } catch (e) {
      toast('Could not load record: ' + e.message, 'error');
      return;
    }
    const box = openModal(
      '<h3>Memory record</h3>' +
      '<dl class="kv">' + kvRows({
        id: rec.id, document: rec.docId || '—', chunk: rec.chunkIndex,
        origin: rec.origin, 'act class': rec.actClass, owner: rec.owner, scope: rec.scope,
        'precision λ': typeof rec.lambda === 'number' ? rec.lambda.toFixed(3) : '—',
        availability: typeof rec.availability === 'number' ? rec.availability.toFixed(3) : '—',
        uses: rec.usage, status: rec.status, flagged: rec.flagged ? 'yes' : 'no',
        'rent charged': rec.rentCharged != null ? rec.rentCharged : '—',
        created: fmtTime(rec.created), updated: fmtTime(rec.updated),
      }) + '</dl>' +
      '<h4>Content</h4><pre style="white-space:pre-wrap">' + esc(rec.content || '(deleted)') + '</pre>' +
      (rec.support && rec.support.length ? '<h4>Support bundle</h4><pre>' + esc(JSON.stringify(rec.support, null, 2)) + '</pre>' : '') +
      (rec.provenance ? '<h4>Provenance</h4><pre>' + esc(JSON.stringify(rec.provenance, null, 2)) + '</pre>' : '') +
      (rec.challenges ? '<h4>Challenge history</h4><pre>' + esc(JSON.stringify(rec.challenges, null, 2)) + '</pre>' : '') +
      (rec.point ? '<h4>Manifold point (H × S × E)</h4><p class="muted small">Hyperbolic dim ' + (rec.point.h ? rec.point.h.length : '?') +
        ' · spherical dim ' + (rec.point.s ? rec.point.s.length : '?') + ' · Euclidean dim ' + (rec.point.e ? rec.point.e.length : '?') + '</p>' : '') +
      '<div id="recResult" class="muted small" style="margin-top:10px"></div>' +
      '<div class="modal-actions" style="justify-content:flex-start">' +
      '<button class="btn small" id="recChallenge">▶ Challenge</button>' +
      (rec.status === 'quarantined' ? '<button class="btn small" id="recRestore">↩ Restore</button>' : '') +
      '<button class="btn small" id="recOutcome">📈 Report outcome</button>' +
      '<button class="btn small" id="recActGate">🛡 Test act gate</button>' +
      (rec.status !== 'deleted' ? '<button class="btn small danger" id="recDelete">🗑 Delete</button>' : '') +
      '<button class="btn small" data-close-modal>Close</button>' +
      '</div>',
      { wide: true }
    );
    const result = (msg, kind) => {
      const el = $('#recResult', box);
      el.textContent = msg;
      el.style.color = kind === 'error' ? 'var(--danger)' : kind === 'ok' ? 'var(--success)' : '';
    };
    const refresh = async () => { closeModal(); await loadMemory(); };
    $('#recChallenge', box).addEventListener('click', async (e) => {
      setLoading(e.currentTarget, true, 'Challenging…');
      try {
        const v = await api('/api/memory/records/' + encodeURIComponent(id) + '/challenge', { method: 'POST', body: {} });
        result('Challenge verdict: ' + v.verdict + (v.reason ? ' — ' + v.reason : '') + (v.lambda != null ? ' · λ now ' + v.lambda.toFixed(2) : ''), v.verdict === 'pass' ? 'ok' : 'error');
        await refresh();
        toast('Challenge: ' + v.verdict, v.verdict === 'pass' ? 'success' : 'error');
        if (v.verdict !== 'pass') openRecordModal(id);
      } catch (err) { result('Challenge failed: ' + err.message, 'error'); }
      finally { setLoading(e.currentTarget, false); }
    });
    const restoreBtn = $('#recRestore', box);
    if (restoreBtn) restoreBtn.addEventListener('click', async () => {
      if (!await confirmDialog('Restore record', 'Restore this quarantined record? Restoration needs a fresh passing challenge and owner confirmation, and is limited to 3 attempts.', 'Restore')) return;
      try {
        const v = await api('/api/memory/records/' + encodeURIComponent(id) + '/restore', { method: 'POST', body: { confirmed: true } });
        if (v.restored) { toast('Record restored', 'success'); closeModal(); await loadMemory(); }
        else toast('Restore refused: ' + (v.reason || 'unknown'), 'error');
      } catch (e) { toast('Restore failed: ' + e.message, 'error'); }
    });
    $('#recOutcome', box).addEventListener('click', async () => {
      const ob = openModal(
        '<h3>Report outcome — Law III</h3>' +
        '<p class="muted">How well did this memory predict? 0 = total success, 1 = total failure. Precision λ moves by η·(1 − 2·surprise).</p>' +
        '<label class="field"><span>Surprise <output id="surpriseOut">0.0</output></span>' +
        '<input id="surpriseInput" type="range" min="0" max="1" step="0.05" value="0"></label>' +
        '<div class="modal-actions"><button class="btn" data-close-modal>Cancel</button>' +
        '<button class="btn primary" id="surpriseSave">Report outcome</button></div>'
      );
      $('#surpriseInput', ob).addEventListener('input', (e) => { $('#surpriseOut', ob).textContent = e.target.value; });
      $('#surpriseSave', ob).addEventListener('click', async () => {
        const surprise = parseFloat($('#surpriseInput', ob).value);
        try {
          const updated = await api('/api/memory/records/' + encodeURIComponent(id) + '/outcome', { method: 'POST', body: { surprise } });
          closeModal();
          toast('Outcome recorded — λ now ' + (updated.lambda != null ? updated.lambda.toFixed(2) : '—'), 'success');
          await loadMemory();
        } catch (e) { toast('Outcome failed: ' + e.message, 'error'); }
      });
    });
    $('#recActGate', box).addEventListener('click', async () => {
      const gb = openModal(
        '<h3>Test the act gate — Law V</h3>' +
        '<p class="muted">Would this record be allowed to drive a consequential action? The gate checks the (origin, act class) pair — never the content.</p>' +
        '<div class="settings-grid">' +
        '<label class="field"><span>Required action class</span><select id="agClass" class="input"><option value="inform">inform</option><option value="act">act</option></select></label>' +
        '<label class="check"><input id="agChannel" type="checkbox"> Channel authorized (trusted_tool act only)</label>' +
        '</div>' +
        '<div class="modal-actions"><button class="btn" data-close-modal>Cancel</button>' +
        '<button class="btn primary" id="agTest">Test gate</button></div>'
      );
      $('#agTest', gb).addEventListener('click', async () => {
        try {
          const v = await api('/api/memory/records/' + encodeURIComponent(id) + '/act-gate', {
            method: 'POST',
            body: { actClass: $('#agClass', gb).value, channelAuthorized: $('#agChannel', gb).checked },
          });
          openModal(
            '<h3>Act gate verdict</h3>' +
            '<p style="font-size:18px;font-weight:700;color:' + (v.allowed ? 'var(--success)' : 'var(--danger)') + '">' +
            (v.allowed ? '✓ ALLOWED' : '✗ DENIED') + '</p>' +
            (v.reason ? '<p class="muted">' + esc(v.reason) + '</p>' : '') +
            (v.pair ? '<pre>' + esc(JSON.stringify(v.pair, null, 2)) + '</pre>' : '') +
            '<div class="modal-actions"><button class="btn" data-close-modal>Close</button></div>'
          );
        } catch (e) { toast('Act gate test failed: ' + e.message, 'error'); }
      });
    });
    $('#recDelete', box).addEventListener('click', async () => {
      if (!await confirmDialog('Delete memory record',
        'Support-closure deletion removes this record and every record whose support bundle depends on it. A certificate with a measured residual-recovery rate is issued. This cannot be undone.',
        'Delete record')) return;
      try {
        const out = await api('/api/memory/records/' + encodeURIComponent(id), { method: 'DELETE' });
        closeModal();
        showCertificate(out);
        await loadMemory();
      } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
    });
  }

  function showCertificate(out) {
    const cert = out.certificate || {};
    openModal(
      '<h3>Deletion certificate</h3>' +
      '<p class="muted">Self-issued, unsigned — it states a measured residual-recovery rate and a scope, it does not prove deletion beyond that scope.</p>' +
      '<dl class="kv">' + kvRows({
        'deleted records': (out.deletedIds || []).length,
        'residual recovery': cert.probeRate != null ? (cert.probeRate * 100).toFixed(1) + '%' : '—',
        scope: cert.scope || '—',
        issuer: cert.issuer || '—',
        timestamp: cert.timestamp || '—',
        'self-issued': cert.selfIssued ? 'yes' : 'no',
        signed: cert.unsigned === false ? 'yes' : 'no',
      }) + '</dl>' +
      '<h4>Deleted record ids</h4><pre>' + esc(JSON.stringify(out.deletedIds || [], null, 2)) + '</pre>' +
      '<h4>Certificate</h4><pre>' + esc(JSON.stringify(cert, null, 2)) + '</pre>' +
      '<div class="modal-actions"><button class="btn primary" data-close-modal>Done</button></div>',
      { wide: true }
    );
  }

  async function loadLedger() {
    const limit = $('#ledgerLimitInput').value || 100;
    try {
      const entries = await api('/api/memory/ledger?limit=' + encodeURIComponent(limit));
      const body = $('#ledgerTableBody');
      $('#ledgerEmpty').classList.toggle('hidden', entries.length > 0);
      body.innerHTML = entries.map((e) =>
        '<tr><td class="small">' + esc(fmtTime(e.ts)) + '</td><td>' + esc(e.type || '') + '</td>' +
        '<td class="small">' + esc(truncate(e.recordId || '—', 18)) + '</td>' +
        '<td class="small"><code>' + esc(truncate(e.hash || '', 16)) + '</code></td>' +
        '<td class="small">' + esc(JSON.stringify(e.detail || {})) + '</td></tr>'
      ).join('');
    } catch (e) {
      toast('Could not load ledger: ' + e.message, 'error');
    }
  }

  async function runScenarios(btn) {
    const report = $('#scenarioReport');
    report.classList.remove('hidden');
    report.innerHTML = '<div class="card"><span class="muted">Running the five theory scenarios…</span></div>';
    setLoading(btn, true, 'Running…');
    try {
      const data = await api('/api/memory/scenarios', { method: 'POST', body: {} });
      const scenarios = data.scenarios || [];
      const passed = data.passed != null ? data.passed : scenarios.filter((s) => s.passed).length;
      const failed = data.failed != null ? data.failed : scenarios.length - passed;
      const allPass = failed === 0;
      report.innerHTML =
        '<div class="scenario-summary ' + (allPass ? 'pass' : 'fail') + '">' +
        (allPass ? '✓ All ' + passed + ' scenarios passed' : '✗ ' + passed + ' passed · ' + failed + ' failed') + '</div>' +
        scenarios.map((s) =>
          '<div class="scenario-card"><div class="sc-head"><h4>' + esc(s.title || s.id || 'Scenario') + '</h4>' +
          '<span class="badge ' + (s.passed ? 'green' : 'red') + '">' + (s.passed ? 'PASS' : 'FAIL') + '</span></div>' +
          (s.description ? '<p class="muted small">' + esc(s.description) + '</p>' : '') +
          '<ul class="scenario-checks">' + (s.checks || []).map((c) =>
            '<li><span class="' + (c.passed ? 'ok' : 'no') + '">' + (c.passed ? '✓' : '✗') + '</span>' +
            '<span>' + esc(c.name || '') + (c.detail ? ' <span class="detail">— ' + esc(c.detail) + '</span>' : '') + '</span></li>'
          ).join('') + '</ul></div>'
        ).join('');
      toast(allPass ? 'All theory scenarios passed' : failed + ' scenario(s) failed', allPass ? 'success' : 'error');
    } catch (e) {
      report.innerHTML = '<div class="card"><span class="error-text">Scenarios could not run: ' + esc(e.message) +
        '</span><p class="muted small" style="margin-top:6px">The endpoint exists in the API, but the server returns an error — the scenarios module may not be loaded yet. The rest of Memory keeps working.</p></div>';
      toast('Scenarios failed: ' + e.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  }

  // ---------------------------------------------------------------- MCP
  async function loadMcp() {
    let servers = [];
    try { servers = await api('/api/mcp'); } catch (e) { toast('Could not load MCP servers: ' + e.message, 'error'); }
    const list = $('#mcpList');
    const empty = $('#mcpEmpty');
    if (!servers.length) { list.innerHTML = ''; empty.classList.remove('hidden'); }
    else {
      empty.classList.add('hidden');
      list.innerHTML = servers.map((s) =>
        '<div class="card" data-id="' + esc(s.id) + '"><div class="card-head"><div><h4>' + esc(s.id) + '</h4>' +
        '<div class="card-sub">' + (s.tools && s.tools.length ? s.tools.length + ' tool(s): ' + esc(s.tools.join(', ')) : 'no tools exposed') + '</div></div>' +
        '<span class="badge ' + (s.state === 'connected' ? 'green' : s.state === 'error' ? 'red' : 'amber') + '">' + esc(s.state) + '</span></div>' +
        '<div class="card-actions"><button class="btn small danger" data-act="disconnect">Disconnect</button></div></div>'
      ).join('');
      $$('.card', list).forEach((card) => {
        card.addEventListener('click', async (e) => {
          if (!e.target.closest('[data-act="disconnect"]')) return;
          const id = card.dataset.id;
          if (!await confirmDialog('Disconnect MCP server', 'Disconnect and unregister "' + id + '"?', 'Disconnect')) return;
          try {
            await api('/api/mcp/' + encodeURIComponent(id), { method: 'DELETE' });
            toast('MCP server disconnected', 'success');
            await loadMcp();
          } catch (err) { toast('Disconnect failed: ' + err.message, 'error'); }
        });
      });
    }
    loadMcpLog();
  }

  async function loadMcpLog() {
    try {
      const lines = await api('/api/mcp/log');
      $('#mcpLog').textContent = lines.length ? lines.map((l) => '[' + fmtTime(l.ts) + '] ' + (l.line || '')).join('\n') : 'No log entries yet.';
    } catch (e) {
      $('#mcpLog').textContent = 'Could not load MCP log: ' + e.message;
    }
  }

  async function registerMcp(btn) {
    const id = $('#mcpId').value.trim();
    const transport = $('#mcpTransport').value;
    if (!id) { toast('Server id is required.', 'error'); return; }
    const body = { id, transport };
    if (transport === 'stdio') {
      body.command = $('#mcpCommand').value.trim();
      const args = $('#mcpArgs').value.split(',').map((s) => s.trim()).filter(Boolean);
      if (args.length) body.args = args;
      const envText = $('#mcpEnv').value.trim();
      if (envText) {
        try { body.env = JSON.parse(envText); } catch { toast('Environment is not valid JSON.', 'error'); return; }
      }
      if (!body.command) { toast('Command is required for stdio transport.', 'error'); return; }
    } else {
      body.url = $('#mcpUrl').value.trim();
      if (!body.url) { toast('URL is required for http transport.', 'error'); return; }
    }
    setLoading(btn, true, 'Registering…');
    try {
      const r = await api('/api/mcp', { method: 'POST', body });
      toast('MCP server registered — state: ' + r.state, r.state === 'connected' ? 'success' : 'error');
      $('#mcpId').value = ''; $('#mcpCommand').value = ''; $('#mcpArgs').value = ''; $('#mcpEnv').value = ''; $('#mcpUrl').value = '';
      $('#mcpFormPanel').classList.add('hidden');
      await loadMcp();
    } catch (e) {
      toast('Registration failed: ' + e.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  }

  // ---------------------------------------------------------------- tools
  async function loadTools() {
    let tools = [];
    try { tools = await api('/api/tools'); } catch (e) { toast('Could not load tools: ' + e.message, 'error'); }
    const list = $('#toolsList');
    $('#toolsEmpty').classList.toggle('hidden', tools.length > 0);
    list.innerHTML = tools.map((t) =>
      '<div class="card"><div class="card-head"><div><h4>' + esc(t.name || t.id) + '</h4>' +
      '<div class="card-sub">' + esc(t.description || '') + '</div></div>' +
      '<span class="badge ' + (t.mcp ? 'blue' : 'grey') + '">' + (t.mcp ? 'MCP' : 'built-in') + '</span></div>' +
      '<div class="card-sub" style="margin-top:6px"><code>' + esc(t.id) + '</code>' + (t.mcp ? ' · server ' + esc(t.mcp) : '') + '</div></div>'
    ).join('');
  }

  // ---------------------------------------------------------------- logs
  function stopLogTimer() {
    if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; }
  }

  async function loadLogs() {
    const level = $('#logLevelFilter').value;
    const limit = $('#logLimitInput').value || 100;
    try {
      const entries = await api('/api/logs?limit=' + encodeURIComponent(limit));
      const filtered = level ? entries.filter((e) => e.level === level) : entries;
      const body = $('#logsTableBody');
      $('#logsEmpty').classList.toggle('hidden', filtered.length > 0);
      body.innerHTML = filtered.map((e) =>
        '<tr><td class="small">' + esc(fmtTime(e.ts)) + '</td>' +
        '<td><span class="badge ' + (e.level === 'error' ? 'red' : e.level === 'warn' ? 'amber' : 'grey') + '">' + esc(e.level || '') + '</span></td>' +
        '<td>' + esc(e.source || '') + '</td>' +
        '<td>' + esc(e.message || '') + '</td>' +
        '<td class="small muted">' + esc((e.providerId || '') + (e.model ? ' · ' + e.model : '')) + '</td></tr>'
      ).join('');
    } catch (e) {
      toast('Could not load logs: ' + e.message, 'error');
    }
  }

  // ---------------------------------------------------------------- wiring
  function bindEvents() {
    $$('.nav-item').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
    $('#sidebarToggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#loginBtn');
      setLoading(btn, true, 'Logging in…');
      try {
        await api('/api/auth/login', { method: 'POST', body: { password: $('#loginPassword').value } });
        hideLogin();
        await bootAfterAuth();
        toast('Logged in', 'success');
      } catch (err) {
        const el = $('#loginError');
        el.textContent = err.status === 401 ? 'Invalid password.' : 'Login failed: ' + err.message;
        el.classList.remove('hidden');
      } finally {
        setLoading(btn, false);
      }
    });
    $('#logoutBtn').addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
      state.auth.authenticated = false;
      showLogin();
    });
    $('#themeToggle').addEventListener('click', async () => {
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      applyTheme(next);
      try {
        state.settings = await api('/api/settings', { method: 'PUT', body: { theme: next } });
      } catch (e) { toast('Could not persist theme: ' + e.message, 'error'); }
    });

    $('#newChatBtn').addEventListener('click', newChat);
    $('#convoFilter').addEventListener('input', renderConversationList);

    $('#providerSelect').addEventListener('change', async () => {
      delete state.modelsByProvider[$('#providerSelect').value];
      await refreshChatSelectors($('#providerSelect').value, '');
    });
    $('#chatSettingsToggle').addEventListener('click', () => {
      const panel = $('#chatSettingsPanel');
      panel.classList.toggle('hidden');
      $('#chatSettingsToggle').setAttribute('aria-expanded', String(!panel.classList.contains('hidden')));
    });
    $('#saveChatSettingsBtn').addEventListener('click', saveChatSettings);
    // Slider value outputs.
    [['temperatureInput', 'temperatureOut'], ['topPInput', 'topPOut'],
     ['frequencyPenaltyInput', 'frequencyPenaltyOut'], ['presencePenaltyInput', 'presencePenaltyOut'],
     ['settingTemperature', 'settingTempOut'], ['settingTopP', 'settingTopPOut'],
     ['settingFrequencyPenalty', 'settingFreqOut'], ['settingPresencePenalty', 'settingPresenceOut']
    ].forEach(([inpId, outId]) => {
      const inp = document.getElementById(inpId);
      const out = document.getElementById(outId);
      if (inp && out) inp.addEventListener('input', () => { out.textContent = inp.value; });
    });

    const composer = $('#composer');
    composer.addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
    const composerInput = $('#composerInput');
    composerInput.addEventListener('input', () => autoGrow(composerInput));
    composerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    $('#stopBtn').addEventListener('click', () => {
      if (state.chatAbort) state.chatAbort.abort();
    });
    $('#templateSelect').addEventListener('change', (e) => {
      const t = state.templates.find((x) => x._id === e.target.value);
      if (t) {
        composerInput.value = composerInput.value ? composerInput.value + '\n' + t.content : t.content;
        autoGrow(composerInput);
        composerInput.focus();
      }
      e.target.value = '';
    });

    $('#addProviderBtn').addEventListener('click', () => openProviderForm(null));

    $('#uploadToggleBtn').addEventListener('click', () => $('#uploadPanel').classList.toggle('hidden'));
    $('#kbUploadJsonBtn').addEventListener('click', (e) => uploadKnowledgeJson(e.currentTarget));
    $('#kbUploadFileBtn').addEventListener('click', (e) => uploadKnowledgeFile(e.currentTarget));
    $('#kbSearchBtn').addEventListener('click', searchKnowledge);
    $('#kbSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchKnowledge(); } });

    $('#memoryRefreshBtn').addEventListener('click', () => loadMemory());
    $('#runScenariosBtn').addEventListener('click', (e) => runScenarios(e.currentTarget));
    $('#dreamBtn').addEventListener('click', async (e) => {
      setLoading(e.currentTarget, true, 'Dreaming…');
      try {
        const r = await api('/api/memory/dream', { method: 'POST', body: {} });
        $('#memoryActionStatus').textContent = 'Dream: ' + r.clusters + ' clusters, ' + r.merged + ' merged, ' + r.promoted + ' promoted.';
        toast('Dream complete: ' + r.merged + ' merged, ' + r.promoted + ' promoted', 'success');
        await loadMemory();
      } catch (err) { toast('Dream failed: ' + err.message, 'error'); }
      finally { setLoading(e.currentTarget, false); }
    });
    $('#relaxBtn').addEventListener('click', async (e) => {
      const box = openModal(
        '<h3>Relax memory (Law IV)</h3>' +
        '<p class="muted">Decay availability by a number of evidence-events. Nothing is deleted — decayed records are restored on re-evidence.</p>' +
        '<label class="field"><span>Evidence-events</span><input id="relaxEvents" class="input" type="number" min="1" max="10000" value="10"></label>' +
        '<div class="modal-actions"><button class="btn" data-close-modal>Cancel</button>' +
        '<button class="btn primary" id="relaxGo">Relax</button></div>'
      );
      $('#relaxGo', box).addEventListener('click', async () => {
        const events = parseInt($('#relaxEvents', box).value, 10) || 1;
        closeModal();
        setLoading(e.currentTarget, true, 'Relaxing…');
        try {
          const r = await api('/api/memory/relax', { method: 'POST', body: { events } });
          $('#memoryActionStatus').textContent = 'Relax: ' + (r.changed || []).length + ' record(s) decayed.';
          toast('Relaxed ' + (r.changed || []).length + ' record(s)', 'success');
          await loadMemory();
        } catch (err) { toast('Relax failed: ' + err.message, 'error'); }
        finally { setLoading(e.currentTarget, false); }
      });
    });
    $('#ledgerToggleBtn').addEventListener('click', () => {
      const panel = $('#ledgerPanel');
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) loadLedger();
    });
    $('#ledgerRefreshBtn').addEventListener('click', loadLedger);
    $('#memoryStatusFilter').addEventListener('change', async () => { state.memoryRecordsCache = await loadMemoryRecords(); renderMemoryTable(); });
    $('#memoryLimitSelect').addEventListener('change', async () => { state.memoryRecordsCache = await loadMemoryRecords(); renderMemoryTable(); });
    $('#memoryFlaggedOnly').addEventListener('change', renderMemoryTable);
    $('#memorySearchInput').addEventListener('input', renderMemoryTable);

    $('#mcpRegisterToggleBtn').addEventListener('click', () => $('#mcpFormPanel').classList.toggle('hidden'));
    $('#mcpTransport').addEventListener('change', (e) => {
      const http = e.target.value === 'http';
      $('#mcpCommandField').classList.toggle('hidden', http);
      $('#mcpArgsField').classList.toggle('hidden', http);
      $('#mcpEnvField').classList.toggle('hidden', http);
      $('#mcpUrlField').classList.toggle('hidden', !http);
    });
    $('#mcpRegisterBtn').addEventListener('click', (e) => registerMcp(e.currentTarget));
    $('#mcpLogRefreshBtn').addEventListener('click', loadMcpLog);

    $('#toolsRefreshBtn').addEventListener('click', loadTools);
    $('#logsRefreshBtn').addEventListener('click', loadLogs);
    $('#logLevelFilter').addEventListener('change', loadLogs);
    $('#logLimitInput').addEventListener('change', loadLogs);
    $('#logAutoRefresh').addEventListener('change', (e) => {
      stopLogTimer();
      if (e.target.checked) state.logTimer = setInterval(loadLogs, 5000);
    });

    $('#settingsSaveBtn').addEventListener('click', saveSettings);
    $('#templateAddBtn').addEventListener('click', () => openTemplateForm(null));

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        newChat();
        showView('chat');
      }
    });
  }

  // ---------------------------------------------------------------- boot
  async function bootAfterAuth() {
    await loadSettings();
    await loadProviders();
    await loadTemplates();
    await loadKnowledge();
    await loadConversations();
    await loadHealth();
    newChat();
  }

  async function init() {
    bindEvents();
    const ok = await checkAuth();
    if (!ok) return;
    await bootAfterAuth();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
