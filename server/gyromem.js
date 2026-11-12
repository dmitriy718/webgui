'use strict';

/**
 * gyromem.js — GyroMem × Mnemodynamics embedding model for WebGUI.
 *
 * Zero dependencies (Node built-ins only), matching the rest of the app.
 *
 * What this is
 * -----------
 * The embedding model is a *composition* of the two companion papers:
 *
 *   GyroMem (geometry — the shape of memory):
 *     - memories live on a product manifold M = H^a x S^b x E^c
 *       (hyperbolic x spherical x Euclidean), curvatures learned per region
 *     - formation maps Euclidean encoder output onto the manifold via the
 *       exponential map; radial position encodes abstraction level
 *     - retrieval is geodesic distance, NOT cosine similarity
 *     - reconsolidation is geodesic transport of a memory point toward a
 *       useful query, confidence-bounded (a contraction: provably stable)
 *     - forgetting is reversible geometric drift (inward = abstraction)
 *
 *   Mnemodynamics (dynamics — the physics of memory; five postulates):
 *     - Law I   Rent:           admission is a decision; expected utility
 *                                must exceed retention cost (one scalar,
 *                                tokens). Raw/minimal records by default.
 *     - Law II  Inference:      retrieval is read-time scoring over
 *                                (similarity, precision lambda, authority
 *                                pair, provenance). Authority is bound at
 *                                write time and frozen; assembly is read
 *                                time, adjudication is write time.
 *     - Law III Reconsolidation: lambda <- clip(lambda + eta*(1-2*surprise)),
 *                                eta in (0, 0.2]; origin is preserved by the
 *                                update; order and updater are logged.
 *     - Law IV  Relaxation:     availability a_t = a_0*exp(-t/tau_relax),
 *                                tau_relax = tau_0*lambda + tau_min;
 *                                availability gates retrieval and is
 *                                restored on re-evidence. Relaxation is NOT
 *                                deletion: deletion is a separate operation
 *                                (support-closure removal + residual probe
 *                                + self-issued certificate).
 *     - Law V   Authority Non-Creation: Auth(m') <= min_i Auth(m_i).
 *                                Authority is the (origin, act_class) pair
 *                                ordered lexicographically, act class first:
 *                                none < inform < act;
 *                                untrusted_external < agent < trusted_tool
 *                                < user. A derived record never exceeds its
 *                                least-trusted source. The act gate enforces
 *                                the pair at the action boundary.
 *     - Epistemic immune system (§3): read-time challenge of retrieved
 *                                memories (pass / undetermined / quarantine),
 *                                authority-inflation detection, reversible
 *                                bounded quarantine, never deletion.
 *
 * Composition honesty (Mnemodynamics §4)
 * ---------------------------------------
 * The papers state explicitly that the geometric composition is an
 * UNTESTED HYPOTHESIS and that four mappings are OPEN: precision lambda
 * has no stated mapping to radial depth; reconsolidation-as-transport is a
 * different operation from the scalar precision update; no geometric rent
 * is defined; no authority field exists in GyroMem. This implementation
 * does NOT pretend those mappings are solved. It runs both layers side by
 * side in one record and composes them with EXPLICIT operational choices,
 * documented in COMPOSITION.md notes inside the code where each choice is
 * made (search for "COMPOSITION"):
 *   (C1) lambda modulates the reconsolidation transport step and the
 *        relaxation timescale (tau_relax = tau_0*lambda + tau_min).
 *        Radial depth is set by abstraction type at formation, NOT by
 *        lambda.
 *   (C2) Geodesic transport and the scalar lambda update are applied
 *        TOGETHER on a successful retrieval (both move, independently).
 *   (C3) Rent is charged in tokens on the Euclidean side of the record
 *        (content length); geometry does not price rent.
 *   (C4) Authority is record metadata consulted by the immune system and
 *        the act gate; it is NOT encoded in the geometry.
 * These are engineering decisions, not theorems. If the papers' Phase 2/3
 * gates later supply a real joint formalism, C1–C4 are the parts to swap.
 *
 * Base encoders
 * -------------
 * The base Euclidean vectors come from a pluggable encoder:
 *   - 'ollama'  : POST {baseUrl}/api/embeddings  (default model
 *                 'nomic-embed-text'; pull it with `ollama pull
 *                 nomic-embed-text`)
 *   - 'openai'  : POST {baseUrl}/v1/embeddings   (OpenAI-compatible)
 *   - 'offline' : deterministic hashed TF embedding, zero network. This is
 *                 a FALLBACK so the app and tests work with no model
 *                 installed. It is not a learned embedding model and its
 *                 quality is far below a real encoder; the active encoder
 *                 is always logged at startup.
 *
 * Conventions: Ganea et al. 2018 (Hyperbolic Neural Networks). Poincare
 * ball B_c^n = {x : c||x||^2 < 1}, curvature -c.
 */

const crypto = require('crypto');

// ===========================================================================
// Vector helpers (plain arrays, no dependencies)
// ===========================================================================

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(a) {
  return Math.sqrt(dot(a, a));
}

function scale(a, s) {
  return a.map((x) => x * s);
}

function add(a, b) {
  return a.map((x, i) => x + b[i]);
}

function sub(a, b) {
  return a.map((x, i) => x - b[i]);
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/** L2-normalize; zero vector stays zero. */
function normalize(a) {
  const n = norm(a);
  if (n === 0) return a.slice();
  return scale(a, 1 / n);
}

function zeros(n) {
  return new Array(n).fill(0);
}

// ===========================================================================
// Mobius / gyrovector operations (Ganea et al. 2018, Eq. 6, 8, 12, 13)
// ===========================================================================

/**
 * Mobius addition x (+) y in the Poincare ball of curvature -c.
 * x (+) 0 = x; 0 (+) y = y.
 */
function mobiusAdd(x, y, c = 1) {
  const xy = dot(x, y);
  const x2 = dot(x, x);
  const y2 = dot(y, y);
  const num1 = 1 + 2 * c * xy + c * y2;
  const num2 = 1 - c * x2;
  const den = 1 + 2 * c * xy + c * c * x2 * y2;
  return x.map((xi, i) => (num1 * xi + num2 * y[i]) / den);
}

/** Mobius scalar multiplication r (x) x. */
function mobiusScalar(r, x, c = 1) {
  const n = norm(x);
  if (n === 0) return x.slice();
  const t = Math.tanh(r * Math.atanh(Math.sqrt(c) * n));
  return scale(x, t / (Math.sqrt(c) * n));
}

/** Exponential map at the origin: exp_0^c(v). */
function exp0(v, c = 1) {
  const n = norm(v);
  if (n === 0) return v.slice();
  return scale(v, Math.tanh(Math.sqrt(c) * n) / (Math.sqrt(c) * n));
}

/** Logarithmic map at the origin: log_0^c(y). */
function log0(y, c = 1) {
  const n = norm(y);
  if (n === 0) return y.slice();
  return scale(y, Math.atanh(clamp(Math.sqrt(c) * n, 0, 1 - 1e-12)) / (Math.sqrt(c) * n));
}

/** Conformal factor lambda_x^c = 2 / (1 - c||x||^2). */
function conformalFactor(x, c = 1) {
  return 2 / (1 - c * dot(x, x));
}

/** Exponential map at x: exp_x^c(v). */
function expX(x, v, c = 1) {
  const lam = conformalFactor(x, c);
  const n = norm(v);
  if (n === 0) return x.slice();
  const inner = scale(v, Math.tanh((Math.sqrt(c) * lam * n) / 2) / (Math.sqrt(c) * n));
  return mobiusAdd(x, inner, c);
}

/** Logarithmic map at x: log_x^c(y). */
function logX(x, y, c = 1) {
  const lam = conformalFactor(x, c);
  const diff = mobiusAdd(scale(x, -1), y, c);
  const n = norm(diff);
  if (n === 0) return diff.slice();
  const coef = (2 / (Math.sqrt(c) * lam)) * Math.atanh(clamp(Math.sqrt(c) * n, 0, 1 - 1e-12));
  return scale(diff, coef / n);
}

/** Poincare ball distance d_c(x, y). */
function poincareDistance(x, y, c = 1) {
  const d = mobiusAdd(scale(x, -1), y, c);
  const n = clamp(Math.sqrt(c) * norm(d), 0, 1 - 1e-12);
  return (2 / Math.sqrt(c)) * Math.atanh(n);
}

/**
 * Geodesic point gamma_{x->y}(t) = exp_x(t * log_x(y)), t in [0, 1].
 * t = 0 gives x; t = 1 gives y. This is the closed-form reconsolidation
 * update (Ganea et al. 2018, Eq. 15).
 */
function geodesic(x, y, t, c = 1) {
  if (t <= 0) return x.slice();
  if (t >= 1) return y.slice();
  return expX(x, scale(logX(x, y, c), t), c);
}

/** Spherical (unit-sphere) geodesic distance: arccos(<x, y>). */
function sphereDistance(x, y) {
  return Math.acos(clamp(dot(normalize(x), normalize(y)), -1, 1));
}

/** Spherical linear interpolation (slerp) from x to y by t in [0, 1]. */
function slerp(x, y, t) {
  const a = normalize(x);
  const b = normalize(y);
  const omega = sphereDistance(a, b);
  if (omega < 1e-9) return a.slice();
  const s0 = Math.sin((1 - t) * omega) / Math.sin(omega);
  const s1 = Math.sin(t * omega) / Math.sin(omega);
  return normalize(add(scale(a, s0), scale(b, s1)));
}

// ===========================================================================
// Product manifold M = H^a x S^b x E^c
// ===========================================================================

const DEFAULT_DIMS = { h: 128, s: 64, e: 192 }; // total 384
const DEFAULT_WEIGHTS = { h: 1.0, s: 0.5, e: 1.0 };

/** Abstraction radii: radial position in the hyperbolic component. */
const ABSTRACTION_RADII = {
  identity: 0.15,
  preference: 0.4,
  episodic: 0.7,
  verbatim: 0.85,
  query: 0.5,
};

/**
 * Split a base Euclidean embedding into the three manifold components.
 * Takes the first h+s+e entries; zero-pads if the base vector is shorter.
 */
function splitEmbedding(vec, dims = DEFAULT_DIMS) {
  const total = dims.h + dims.s + dims.e;
  const padded = vec.slice(0, total);
  while (padded.length < total) padded.push(0);
  return {
    h: padded.slice(0, dims.h),
    s: padded.slice(dims.h, dims.h + dims.s),
    e: padded.slice(dims.h + dims.s, total),
  };
}

/**
 * Form a manifold point from a base Euclidean embedding.
 * - hyperbolic: direction from the base vector, radius set by abstraction
 *   (exp_0 maps pre-image norm atanh(r)/sqrt(c) to radius r exactly)
 * - spherical: base components L2-normalized onto the unit sphere
 * - Euclidean: base components as-is
 */
function formPoint(baseVec, opts = {}) {
  const dims = opts.dims || DEFAULT_DIMS;
  const c = opts.curvature || 1;
  const abstraction = opts.abstraction || 'episodic';
  const radius = ABSTRACTION_RADII[abstraction] ?? ABSTRACTION_RADII.episodic;
  const parts = splitEmbedding(baseVec, dims);

  // Hyperbolic: place at exact radius r along the base direction.
  const hDir = normalize(parts.h);
  const hPre = scale(hDir, Math.atanh(radius) / Math.sqrt(c));
  const h = exp0(hPre, c);

  const s = normalize(parts.s);
  const e = parts.e.slice();
  return { h, s, e };
}

/** Weighted product geodesic distance d_M(p, q). */
function productDistance(p, q, weights = DEFAULT_WEIGHTS, curvature = 1) {
  const dh = poincareDistance(p.h, q.h, curvature);
  const ds = sphereDistance(p.s, q.s);
  const de = norm(sub(p.e, q.e));
  return Math.sqrt(
    weights.h * dh * dh + weights.s * ds * ds + weights.e * de * de
  );
}

/**
 * Geodesic transport of point p toward q by step t in [0, 1]:
 * hyperbolic component moves along the Poincare geodesic, spherical via
 * slerp, Euclidean linearly. This is the GyroMem reconsolidation update.
 */
function transportPoint(p, q, t, curvature = 1) {
  if (t <= 0) return { h: p.h.slice(), s: p.s.slice(), e: p.e.slice() };
  if (t >= 1) return { h: q.h.slice(), s: q.s.slice(), e: q.e.slice() };
  return {
    h: geodesic(p.h, q.h, t, curvature),
    s: slerp(p.s, q.s, t),
    e: p.e.map((x, i) => x + t * (q.e[i] - x)),
  };
}

/** Radial depth of a point's hyperbolic component (0 = origin/abstract). */
function radialDepth(point) {
  return norm(point.h);
}

// ===========================================================================
// Base encoders (pluggable; the geometric layer sits on top of any of them)
// ===========================================================================

const TOKEN_RE = /[a-z0-9]+/gi;

/** Rough token estimate for rent accounting (chars / 4). */
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

/**
 * Offline fallback encoder: deterministic hashed TF embedding.
 * NOT a learned model. Tokens are hashed into buckets with a sign,
 * accumulated, then L2-normalized. Deterministic across runs, zero network.
 * Quality is far below a real encoder — it exists so the app and the test
 * suite work with no model installed, and so the geometry/dynamics can be
 * exercised end to end before an embedding model is pulled.
 */
class OfflineEncoder {
  constructor({ dim = 384 } = {}) {
    this.kind = 'offline';
    this.model = 'offline-hashed-tf';
    this.dim = dim;
  }

  embedOne(text) {
    const vec = zeros(this.dim);
    const tokens = String(text || '').toLowerCase().match(TOKEN_RE) || [];
    for (const tok of tokens) {
      const h = crypto.createHash('sha256').update(tok).digest();
      const bucket = h.readUInt32BE(0) % this.dim;
      const sign = h[4] % 2 === 0 ? 1 : -1;
      vec[bucket] += sign;
    }
    return normalize(vec);
  }

  async embed(texts) {
    return texts.map((t) => this.embedOne(t));
  }
}

/** Ollama native embeddings endpoint: POST {baseUrl}/api/embeddings. */
class OllamaEncoder {
  constructor({ baseUrl, model = 'nomic-embed-text', timeoutMs = 30000 } = {}) {
    this.kind = 'ollama';
    this.baseUrl = String(baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async embedOne(text) {
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: String(text || '') }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw Object.assign(new Error(`Ollama embeddings failed: HTTP ${res.status}`), { status: res.status });
    }
    const data = await res.json();
    if (!Array.isArray(data.embedding)) throw new Error('Ollama embeddings: no embedding in response');
    return data.embedding;
  }

  async embed(texts) {
    const out = [];
    for (const t of texts) out.push(await this.embedOne(t));
    return out;
  }
}

/** OpenAI-compatible embeddings endpoint: POST {baseUrl}/v1/embeddings. */
class OpenAIEncoder {
  constructor({ baseUrl, apiKey = '', model = 'text-embedding-3-small', timeoutMs = 30000 } = {}) {
    this.kind = 'openai';
    this.baseUrl = String(baseUrl || 'http://localhost:1234/v1').replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async embed(texts) {
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.model, input: texts.map((t) => String(t || '')) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw Object.assign(new Error(`Embeddings failed: HTTP ${res.status}`), { status: res.status });
    }
    const data = await res.json();
    const arr = (data.data || []).sort((a, b) => a.index - b.index);
    if (arr.length !== texts.length) throw new Error('Embeddings: response count mismatch');
    return arr.map((d) => d.embedding);
  }

  async embedOne(text) {
    return (await this.embed([text]))[0];
  }
}

/**
 * Build an encoder from a WebGUI provider doc ({ kind, baseUrl, apiKey })
 * plus an embedding model name. kind 'ollama' -> OllamaEncoder,
 * kind 'openai' -> OpenAIEncoder, anything else -> OfflineEncoder.
 */
function encoderFromProvider(provider, embeddingModel) {
  if (!provider) return new OfflineEncoder();
  if (provider.kind === 'ollama') {
    return new OllamaEncoder({ baseUrl: provider.baseUrl, model: embeddingModel || 'nomic-embed-text' });
  }
  if (provider.kind === 'openai') {
    return new OpenAIEncoder({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: embeddingModel || 'text-embedding-3-small' });
  }
  return new OfflineEncoder();
}

// ===========================================================================
// Authority lattice (Mnemodynamics Law V)
// ===========================================================================

const ORIGINS = ['untrusted_external', 'agent', 'trusted_tool', 'user'];
const ACT_CLASSES = ['none', 'inform', 'act'];

const ORIGIN_RANK = { untrusted_external: 0, agent: 1, trusted_tool: 2, user: 3 };
const ACT_RANK = { none: 0, inform: 1, act: 2 };

/** Origin cap on act_class (Law V): untrusted -> none; agent -> inform. */
const ORIGIN_ACT_CAP = {
  untrusted_external: 'none',
  agent: 'inform',
  trusted_tool: 'act', // act only when channel auth + deployment policy jointly authorize; see actGate
  user: 'act',
};

/**
 * Lexicographic pair order, act class first:
 * (o1,a1) <= (o2,a2) iff a1 < a2, or a1 == a2 and o1 <= o2.
 * Returns -1 / 0 / 1.
 */
function compareAuthority(p1, p2) {
  const a1 = ACT_RANK[p1.actClass] ?? 0;
  const a2 = ACT_RANK[p2.actClass] ?? 0;
  if (a1 !== a2) return a1 < a2 ? -1 : 1;
  const o1 = ORIGIN_RANK[p1.origin] ?? 0;
  const o2 = ORIGIN_RANK[p2.origin] ?? 0;
  if (o1 !== o2) return o1 < o2 ? -1 : 1;
  return 0;
}

/** The meet (lexicographic minimum) of a set of authority pairs. */
function minAuthority(pairs) {
  if (!pairs.length) return { origin: 'untrusted_external', actClass: 'none' };
  return pairs.reduce((min, p) => (compareAuthority(p, min) < 0 ? p : min));
}

/**
 * Cap a requested act_class by origin (Law V origin caps).
 * Also: an agent-generated record never claims 'act'.
 */
function capActClass(origin, actClass) {
  const cap = ORIGIN_ACT_CAP[origin] || 'none';
  return ACT_RANK[actClass] > ACT_RANK[cap] ? cap : actClass;
}

/** Does authority pair `have` cover the required action class? */
function authorityCovers(pair, requiredActClass) {
  return ACT_RANK[pair.actClass] >= ACT_RANK[requiredActClass];
}

// ===========================================================================
// GyroMemStore — one record carries BOTH layers:
//   geometry (GyroMem point, retrieval, transport, drift)
//   dynamics (Mnemodynamics lambda, authority, availability, provenance)
// ===========================================================================

const DEFAULT_CONFIG = {
  dims: DEFAULT_DIMS,
  weights: DEFAULT_WEIGHTS,
  curvature: 1,
  eta: 0.1, // Law III learning rate, must be in (0, 0.2]
  tau0: 20, // Law IV relaxation timescale (evidence-events)
  tauMin: 2,
  aFloor: 0.05, // Law IV retrieval floor
  rentPerToken: 0.0004, // Law I: admission cost per token (utility units)
  rentThreshold: 0, // admit when utility - cost > threshold
  maxRecords: 10000,
  challengePassBonus: 0.02, // immune challenge pass: +lambda (paper §3)
  challengeBonusCap: 0.1, // lifetime cap on challenge-granted lambda
  quarantineMaxRestores: 3,
  quarantineCooldownMs: 60 * 60 * 1000,
  clusterEps: 0.35, // dream(): cluster radius (geodesic)
  dedupEps: 0.08, // dream(): merge radius (geodesic)
  owner: 'local',
};

function ledgerHash(prevHash, entry) {
  return crypto.createHash('sha256').update(`${prevHash}:${JSON.stringify(entry)}`).digest('hex');
}

class GyroMemStore {
  /**
   * @param {Store} records   JSON store collection for memory records.
   * @param {Store|null} ledger JSON store collection for the audit ledger
   *   (may be null: ledger then lives in memory only).
   * @param {object} config   See DEFAULT_CONFIG.
   */
  constructor(records, ledger, config = {}) {
    if (!records || typeof records.all !== 'function') {
      throw new Error('GyroMemStore requires a Store collection for records');
    }
    this.records = records;
    this.ledgerStore = ledger || null;
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (!(this.config.eta > 0 && this.config.eta <= 0.2)) {
      throw new Error('Law III eta must be in (0, 0.2]');
    }
    this.encoder = new OfflineEncoder({ dim: this.config.dims.h + this.config.dims.s + this.config.dims.e });
    this.encoderKind = 'offline';
    /** @type {Map<string, object>} */
    this._map = new Map();
    for (const doc of this.records.all()) {
      if (doc && doc._id) this._map.set(doc._id, doc);
    }
    this._lastLedgerHash = 'genesis';
    if (this.ledgerStore) {
      const entries = this.ledgerStore.all().sort((a, b) => a.ts - b.ts);
      if (entries.length) this._lastLedgerHash = entries[entries.length - 1].hash || 'genesis';
    }
  }

  // -- encoder -------------------------------------------------------------

  /**
   * Resolve the active encoder from a WebGUI provider doc. Falls back to
   * the offline encoder (and reports which is active) when no provider is
   * given or the provider cannot be used. Returns { kind, model }.
   */
  async ensureEncoder(provider, embeddingModel) {
    const enc = encoderFromProvider(provider, embeddingModel);
    if (enc.kind === 'offline') {
      this.encoder = enc;
      this.encoderKind = 'offline';
      return { kind: 'offline', model: enc.model };
    }
    // Probe the encoder with a tiny request so a broken config fails fast
    // and falls back instead of failing mid-index.
    try {
      await enc.embedOne('gyro-mem encoder probe');
      this.encoder = enc;
      this.encoderKind = enc.kind;
      return { kind: enc.kind, model: enc.model };
    } catch {
      this.encoder = new OfflineEncoder({ dim: this.config.dims.h + this.config.dims.s + this.config.dims.e });
      this.encoderKind = 'offline';
      return { kind: 'offline', model: this.encoder.model, fallbackReason: 'probe failed' };
    }
  }

  async encodeQuery(text, abstraction = 'query') {
    const vec = await this.encoder.embedOne(text);
    return formPoint(vec, { dims: this.config.dims, curvature: this.config.curvature, abstraction });
  }

  // -- persistence ----------------------------------------------------------

  _persist(rec) {
    if (this.records.get(rec._id)) this.records.replace(rec);
    else this.records.insert(rec);
    this._map.set(rec._id, rec);
    return rec;
  }

  _remove(id) {
    this.records.delete(id);
    this._map.delete(id);
  }

  _logLedger(type, recordId, detail) {
    const entry = { ts: Date.now(), type, recordId: recordId || null, detail: detail || {} };
    const hash = ledgerHash(this._lastLedgerHash, entry);
    const full = { ...entry, prevHash: this._lastLedgerHash, hash };
    this._lastLedgerHash = hash;
    if (this.ledgerStore) {
      try { this.ledgerStore.insert(full); } catch { /* ledger is best-effort */ }
    }
    return full;
  }

  /** Remove all records of a source document (e.g. knowledge doc deleted). Content cleared, one ledger entry. */
  removeDoc(docId) {
    const ids = this.recordsByDoc(docId).map((r) => r._id);
    for (const id of ids) {
      const r = this._map.get(id);
      if (r && r.status !== 'deleted') {
        r.status = 'deleted';
        r.content = '';
        r.point = null;
        r.updated = Date.now();
        this._persist(r);
      }
    }
    if (ids.length) this._logLedger('remove-doc', null, { docId, removed: ids.length });
    return ids;
  }

  count() {
    return this._map.size;
  }

  /** Records belonging to one source document (for re-index dedup). */
  recordsByDoc(docId) {
    return [...this._map.values()].filter((r) => r.docId === docId);
  }

  getRecord(id) {
    return this._map.get(id) || null;
  }

  liveRecords() {
    return [...this._map.values()].filter((r) => r.status === 'live' && !r.flagged);
  }

  // -- Law I: Rent (admission) ----------------------------------------------

  /**
   * Admit a chunk as a memory record. Rent is charged in tokens (one
   * scalar unit, per Law I): cost = tokens * rentPerToken. Utility is
   * novelty = 1 - similarity to the nearest existing record, where
   * similarity = 1 / (1 + d_M). Admit when utility - cost > rentThreshold.
   * Raw/minimally-processed content is the default (no elaboration).
   *
   * COMPOSITION (C3): rent is priced on the Euclidean side (content
   * length). Geometry does not price rent — no geometric rent is defined
   * in the papers.
   */
  async index(docId, chunkIndex, content, opts = {}) {
    const text = String(content || '').trim();
    if (!text) return { admitted: false, reason: 'empty content' };
    if (this._map.size >= this.config.maxRecords) {
      return { admitted: false, reason: 'record budget exhausted' };
    }

    const origin = ORIGINS.includes(opts.origin) ? opts.origin : 'user';
    const actClass = capActClass(origin, opts.actClass || 'inform');
    const tokens = estimateTokens(text);
    const cost = tokens * this.config.rentPerToken;

    // Encode + form the manifold point before the rent decision, so
    // novelty is measured geometrically.
    const vec = await this.encoder.embedOne(text);
    const point = formPoint(vec, {
      dims: this.config.dims,
      curvature: this.config.curvature,
      abstraction: opts.abstraction || 'episodic',
    });

    let novelty = 1;
    let nearest = null;
    if (this._map.size) {
      let best = Infinity;
      for (const rec of this._map.values()) {
        if (rec.status === 'deleted') continue;
        const d = productDistance(point, rec.point, this.config.weights, this.config.curvature);
        if (d < best) { best = d; nearest = rec._id; }
      }
      novelty = 1 - 1 / (1 + best);
    }
    const utility = novelty;
    if (utility - cost <= this.config.rentThreshold) {
      return { admitted: false, reason: 'rent gate: utility below retention cost', utility, cost, nearest };
    }

    const now = Date.now();
    const rec = {
      _id: crypto.randomUUID(),
      docId: docId || null,
      chunkIndex: typeof chunkIndex === 'number' ? chunkIndex : 0,
      content: text,
      point,
      lambda: typeof opts.lambda === 'number' ? clamp(opts.lambda, 0, 1) : 0.5,
      origin,
      actClass,
      owner: opts.owner || this.config.owner,
      scope: opts.scope || 'general',
      availability: 1,
      usage: 0,
      lastUsed: 0,
      created: now,
      updated: now,
      support: Array.isArray(opts.support) ? opts.support.slice() : [],
      provenance: {
        updater: opts.updater || 'index',
        order: 0,
        sources: Array.isArray(opts.sources) ? opts.sources.slice() : [],
        history: [{ ts: now, event: 'admit', updater: opts.updater || 'index', preLambda: null }],
      },
      challenges: { passed: 0, failed: 0, bonusTotal: 0, lastVerdict: null, restores: 0, restoredAt: 0 },
      status: 'live',
      flagged: false,
      rentCharged: cost,
    };
    this._persist(rec);
    this._logLedger('admit', rec._id, { docId, tokens, cost, utility });
    return { admitted: true, record: rec, utility, cost };
  }

  // -- Law II: Inference (read-time retrieval) --------------------------------

  /**
   * Retrieve memories for a query. Scoring is the Law II surrogate ranking
   * over (geodesic similarity, precision lambda, authority pair,
   * provenance) — not a posterior. Authority is the write-time bound pair,
   * never re-derived from content at read time. Records below the Law IV
   * availability floor, flagged, quarantined, or deleted are not returned.
   *
   * Authority filtering: ordinary retrieval is an *inform* use — every
   * live record is returned (labeled with its origin), and the immune
   * challenge judges it before consumption. Only an *act* retrieval
   * (opts.actClass === 'act', i.e. records that will authorize action)
   * filters to records whose pair covers 'act'. This is the paper's
   * split: untrusted content is read as labeled untrusted input, never
   * as an instruction and never as authorization.
   *
   * Each returned record is immune-challenged (unless opts.challenge is
   * false) before consumption.
   */
  async retrieve(queryText, opts = {}) {
    const k = opts.k || 4;
    const q = String(queryText || '').trim();
    if (!q) return [];
    const queryPoint = await this.encodeQuery(q, opts.abstraction || 'query');
    const requiredAct = opts.actClass || 'inform';

    const scored = [];
    for (const rec of this.liveRecords()) {
      if (rec.availability < this.config.aFloor) continue;
      // Act-mode retrieval only: only records whose pair covers 'act'
      // may authorize action. Inform-mode returns all live records,
      // labeled, for the immune challenge to judge.
      if (requiredAct === 'act' && !authorityCovers({ origin: rec.origin, actClass: rec.actClass }, 'act')) continue;
      const d = productDistance(queryPoint, rec.point, this.config.weights, this.config.curvature);
      const sim = 1 / (1 + d);
      const authorityBonus =
        (ACT_RANK[rec.actClass] / 2) * 0.1 + (ORIGIN_RANK[rec.origin] / 3) * 0.1;
      const score = sim + 0.3 * rec.lambda + authorityBonus;
      scored.push({ record: rec, distance: d, similarity: sim, score, queryPoint });
    }
    scored.sort((a, z) => z.score - a.score);
    const top = scored.slice(0, k);

    if (opts.challenge !== false) {
      const out = [];
      for (const hit of top) {
        const verdict = this.challenge(hit.record._id, { query: q, peers: top.map((t) => t.record) });
        if (verdict.verdict === 'quarantine') continue;
        if (verdict.verdict === 'undetermined') {
          hit.record.flagged = true;
          this._persist(hit.record);
          continue;
        }
        out.push(hit);
      }
      return out;
    }
    return top;
  }

  // -- Law III: Reconsolidation ----------------------------------------------

  /**
   * Report a task outcome for a record: surprise in [0, 1] is the
   * predictive-failure score (0 = success, 1 = failure).
   *   lambda <- clip(lambda + eta * (1 - 2*surprise))
   * COMPOSITION (C2): the scalar lambda update and the geodesic transport
   * are applied together — the transport step is eta * confidence where
   * confidence = 1 - surprise. Origin is preserved (invariant) and the
   * update event (order, updater, pre-update lambda) is logged.
   */
  reportOutcome(recordId, surprise, updater = 'consumer') {
    const rec = this._map.get(recordId);
    if (!rec || rec.status === 'deleted') return null;
    const s = clamp(typeof surprise === 'number' ? surprise : 0.5, 0, 1);
    const preLambda = rec.lambda;
    rec.lambda = clamp(rec.lambda + this.config.eta * (1 - 2 * s), 0, 1);
    rec.provenance.history.push({ ts: Date.now(), event: 'reconsolidate', updater, preLambda, surprise: s });
    rec.provenance.order += 1;
    rec.updated = Date.now();
    this._persist(rec);
    this._logLedger('reconsolidate', recordId, { updater, preLambda, lambda: rec.lambda, surprise: s });
    return rec;
  }

  /**
   * Geodesic reconsolidation step: move the record's point toward the
   * query point by step = eta * confidence (confidence in [0, 1]).
   * A contraction toward the query (GyroMem stability sketch); the step
   * is bounded by eta <= 0.2, so no runaway drift. Origin untouched.
   * Called by retrieve() via transportOnRetrieval (below) and directly
   * by consumers that hold the query point.
   */
  transport(recordId, queryPoint, confidence, updater = 'retrieval') {
    const rec = this._map.get(recordId);
    if (!rec || rec.status === 'deleted' || !queryPoint) return null;
    const step = this.config.eta * clamp(confidence, 0, 1);
    if (step <= 0) return rec;
    rec.point = transportPoint(rec.point, queryPoint, step, this.config.curvature);
    rec.usage += 1;
    rec.lastUsed = Date.now();
    rec.availability = 1; // re-evidence restores availability (Law IV)
    rec.updated = Date.now();
    rec.provenance.history.push({ ts: Date.now(), event: 'transport', updater, step });
    this._persist(rec);
    return rec;
  }

  /**
   * Convenience: retrieve + transport each hit toward the query (the
   * "retrieval rewires the store" loop). Returns the same shape as
   * retrieve(). Lambda moves only via reportOutcome(), never here.
   */
  async retrieveAndReconsolidate(queryText, opts = {}) {
    const hits = await this.retrieve(queryText, opts);
    for (const hit of hits) {
      this.transport(hit.record._id, hit.queryPoint, hit.similarity, 'retrieval');
    }
    return hits;
  }

  // -- Law IV: Relaxation (availability decay, NOT deletion) --------------------

  /**
   * Decay availability by `events` evidence-events (agent interactions,
   * not wall-clock time): a <- a * exp(-events / tau_relax),
   * tau_relax = tau_0 * lambda + tau_min. Records keep content and
   * evidence logs; only availability falls. Below aFloor they stop being
   * returned, but are restorable.
   */
  relax(events = 1) {
    const ev = Math.max(0, events);
    const changed = [];
    for (const rec of this._map.values()) {
      if (rec.status !== 'live') continue;
      const tau = this.config.tau0 * rec.lambda + this.config.tauMin;
      const next = rec.availability * Math.exp(-ev / tau);
      if (next !== rec.availability) {
        rec.availability = next;
        rec.updated = Date.now();
        this._persist(rec);
        changed.push(rec._id);
      }
    }
    if (changed.length) this._logLedger('relax', null, { events: ev, changed: changed.length });
    return changed;
  }

  /** Re-evidence restores availability to baseline (Law IV). */
  restoreOnEvidence(recordId) {
    const rec = this._map.get(recordId);
    if (!rec || rec.status === 'deleted') return null;
    rec.availability = 1;
    rec.updated = Date.now();
    this._persist(rec);
    return rec;
  }

  // -- Epistemic immune system (§3): read-time challenge ------------------------

  /**
   * Heuristic probe suite (the paper's "as built" status: heuristic, not
   * a verified detector). Probes:
   *   (P1) authority inflation: a derived record's stored pair must not
   *        exceed the minimum pair of its provenance sources. Violation
   *        -> quarantine (cap violation by definition, Law V).
   *   (P2) consensus: token overlap with the peer retrieved set; a record
   *        with no overlap AND untrusted_external origin -> undetermined.
   *   (P3) precision floor: lambda < 0.2 with prior failed challenges ->
   *        quarantine (persistent failure).
   * Verdicts: pass (lambda += 0.02, lifetime cap +0.10), undetermined
   * (flagged, excluded from ordinary retrieval until re-challenge or
   * owner review), quarantine (status quarantined; reversible via
   * restoreQuarantined, never deletion). The agent whose memory is probed
   * never scores its own challenge: challenge() runs in the monitor role
   * (this store), not in the consumer.
   */
  challenge(recordId, context = {}) {
    const rec = this._map.get(recordId);
    if (!rec) return { verdict: 'quarantine', reason: 'record not found' };
    if (rec.status !== 'live') return { verdict: rec.status, reason: `record is ${rec.status}` };

    // P1: authority inflation against declared provenance.
    const sources = rec.provenance.sources || [];
    if (sources.length) {
      const sourcePairs = [];
      for (const sid of sources) {
        const s = this._map.get(sid);
        if (s) sourcePairs.push({ origin: s.origin, actClass: s.actClass });
      }
      if (sourcePairs.length) {
        const cap = minAuthority(sourcePairs);
        if (compareAuthority({ origin: rec.origin, actClass: rec.actClass }, cap) > 0) {
          return this._quarantine(rec, 'authority inflation: stored pair exceeds least-trusted source');
        }
      }
    }

    // P2: consensus with peers (token-overlap heuristic).
    const peers = Array.isArray(context.peers) ? context.peers.filter((p) => p._id !== recordId) : [];
    if (peers.length && rec.origin === 'untrusted_external') {
      const toks = new Set(String(rec.content).toLowerCase().match(TOKEN_RE) || []);
      let overlap = 0;
      for (const p of peers) {
        const pt = new Set(String(p.content).toLowerCase().match(TOKEN_RE) || []);
        for (const t of toks) if (pt.has(t)) { overlap++; break; }
      }
      if (overlap === 0) {
        return this._undetermined(rec, 'no consensus overlap with peer records (untrusted origin)');
      }
    }

    // P3: persistent failure.
    if (rec.lambda < 0.2 && rec.challenges.failed >= 2) {
      return this._quarantine(rec, 'persistent challenge failure at low precision');
    }

    // Pass: small bounded precision grant (paper §3).
    rec.challenges.passed += 1;
    rec.challenges.lastVerdict = 'pass';
    const grant = Math.min(this.config.challengePassBonus, this.config.challengeBonusCap - rec.challenges.bonusTotal);
    if (grant > 0) {
      rec.lambda = clamp(rec.lambda + grant, 0, 1);
      rec.challenges.bonusTotal += grant;
    }
    rec.updated = Date.now();
    this._persist(rec);
    this._logLedger('challenge-pass', recordId, { lambda: rec.lambda });
    return { verdict: 'pass', reason: 'probes passed', lambda: rec.lambda };
  }

  _undetermined(rec, reason) {
    rec.challenges.lastVerdict = 'undetermined';
    rec.flagged = true;
    rec.updated = Date.now();
    this._persist(rec);
    this._logLedger('challenge-undetermined', rec._id, { reason });
    return { verdict: 'undetermined', reason };
  }

  _quarantine(rec, reason) {
    rec.challenges.failed += 1;
    rec.challenges.lastVerdict = 'quarantine';
    rec.status = 'quarantined';
    rec.updated = Date.now();
    this._persist(rec);
    this._logLedger('quarantine', rec._id, { reason });
    return { verdict: 'quarantine', reason };
  }

  /**
   * Restore a quarantined record after a fresh passing challenge, with
   * owner/administrator confirmation as a design requirement, bounded
   * restores and a cooling-off interval. Restoration is a status change
   * via re-challenge, not Law IV decay.
   */
  restoreQuarantined(recordId, { confirmed = false } = {}) {
    const rec = this._map.get(recordId);
    if (!rec || rec.status !== 'quarantined') return null;
    if (!confirmed) return { restored: false, reason: 'owner/administrator confirmation required' };
    if (rec.challenges.restores >= this.config.quarantineMaxRestores) {
      return { restored: false, reason: 'maximum restoration attempts reached' };
    }
    if (Date.now() - (rec.challenges.restoredAt || 0) < this.config.quarantineCooldownMs && rec.challenges.restores > 0) {
      return { restored: false, reason: 'cooling-off interval has not elapsed' };
    }
    rec.status = 'live';
    rec.flagged = false;
    rec.challenges.restores += 1;
    rec.challenges.restoredAt = Date.now();
    rec.challenges.failed = 0;
    rec.updated = Date.now();
    this._persist(rec);
    this._logLedger('quarantine-restore', recordId, { restores: rec.challenges.restores });
    return { restored: true, record: rec };
  }

  // -- Law V: act gate ----------------------------------------------------------

  /**
   * Act gate (design requirement, enforced here): a consequential action
   * is allowed only when the acting record's authority pair covers the
   * required action class. For 'act' from a trusted_tool record, the
   * deployment must ALSO pass channelAuthorized: true (channel
   * authentication + deployment policy jointly authorize). Verdicts are
   * written to the append-only hash-chained ledger either way.
   */
  actGate(recordId, requiredActClass, opts = {}) {
    const rec = this._map.get(recordId);
    const required = ACT_CLASSES.includes(requiredActClass) ? requiredActClass : 'act';
    if (!rec) {
      this._logLedger('act-gate-deny', recordId, { required, reason: 'record not found' });
      return { allowed: false, reason: 'record not found' };
    }
    // A quarantined, flagged, or deleted record authorizes nothing — the
    // immune system's verdict is part of the authority the gate consults.
    // (Without this, a laundered record whose stored pair was inflated
    // would pass the gate on its stored pair alone.)
    if (rec.status !== 'live' || rec.flagged) {
      this._logLedger('act-gate-deny', recordId, { required, reason: `record is ${rec.flagged ? 'flagged' : rec.status}` });
      return { allowed: false, reason: `record is ${rec.flagged ? 'flagged' : rec.status}` };
    }
    const pair = { origin: rec.origin, actClass: rec.actClass };
    if (!authorityCovers(pair, required)) {
      this._logLedger('act-gate-deny', recordId, { required, pair, reason: 'authority does not cover action class' });
      return { allowed: false, reason: 'authority does not cover action class', pair };
    }
    if (required === 'act' && rec.origin === 'trusted_tool' && !opts.channelAuthorized) {
      this._logLedger('act-gate-deny', recordId, { required, pair, reason: 'trusted_tool act requires channel authorization' });
      return { allowed: false, reason: 'trusted_tool act requires channel authorization', pair };
    }
    this._logLedger('act-gate-allow', recordId, { required, pair });
    return { allowed: true, pair };
  }

  // -- Law IV/V: deletion (separate from relaxation) ---------------------------

  /**
   * Deletion operation (paper §2.5). Support-closure removal: a record
   * stays live while ANY support bundle survives intact; it is deleted
   * when EVERY bundle contains a deleted id. Single-bundle rule as built.
   * Then the fixed-reader residual probe (lexical channel) attempts to
   * reconstruct the deleted content from the remaining store, and the
   * measured rate is reported — never a bare "deleted" boolean.
   * The certificate is SELF-ISSUED and UNSIGNED (no signature key, no
   * independent attestation). Scope: text store only, point-in-time.
   */
  deleteRecord(recordId) {
    const rec = this._map.get(recordId);
    if (!rec) return null;
    if (rec.status === 'deleted') return { alreadyDeleted: true, record: rec };

    const toDelete = new Set([recordId, ...(rec.support || [])]);
    // Support-closure: any record whose every bundle contains a deleted id.
    let grew = true;
    while (grew) {
      grew = false;
      for (const other of this._map.values()) {
        if (toDelete.has(other._id) || other.status === 'deleted') continue;
        const bundles = other.support && other.support.length ? [other.support] : [];
        if (bundles.length && bundles.every((b) => b.some((id) => toDelete.has(id)))) {
          toDelete.add(other._id);
          grew = true;
        }
      }
    }

    const deletedIds = [...toDelete];
    const deletedContents = [];
    for (const id of deletedIds) {
      const r = this._map.get(id);
      if (r) {
        deletedContents.push(r.content);
        r.status = 'deleted';
        r.content = '';
        r.point = null;
        r.updated = Date.now();
        this._persist(r);
      }
    }

    // Fixed-reader residual probe (lexical channel): can the deleted
    // content be reconstructed from remaining live records?
    let recovered = 0;
    for (const content of deletedContents) {
      const toks = new Set(String(content).toLowerCase().match(TOKEN_RE) || []);
      if (toks.size < 3) continue;
      for (const other of this._map.values()) {
        if (other.status !== 'live' || !other.content) continue;
        const ot = new Set(String(other.content).toLowerCase().match(TOKEN_RE) || []);
        let matched = 0;
        for (const t of toks) if (ot.has(t)) matched++;
        if (matched >= 3 && matched / toks.size >= 0.5) { recovered++; break; }
      }
    }
    const probeRate = deletedContents.length ? recovered / deletedContents.length : 0;

    const certificate = {
      recordIds: deletedIds,
      bundlesRemoved: deletedIds.length,
      probeRate,
      probeChannels: { lexical: probeRate },
      auditDraws: 5,
      scope: 'text-store-only',
      issuer: 'gyromem',
      timestamp: new Date().toISOString(),
      selfIssued: true,
      unsigned: true,
      verification: 're-run the fixed-reader probe against the post-deletion store; the rate must reproduce exactly',
    };
    this._logLedger('delete', recordId, { deletedIds, probeRate });
    return { deletedIds, certificate };
  }

  // -- Dreaming consolidation (offline, EngramRAG-style) -----------------------

  /**
   * Offline consolidation: greedily cluster live records by geodesic
   * distance; move each cluster's members slightly inward (radial
   * promotion = abstraction), and merge near-duplicates (distance <
   * dedupEps) keeping the higher-lambda record, merging provenance with
   * authority = min pair (Law V cap). Returns a summary.
   */
  dream() {
    const live = this.liveRecords();
    const visited = new Set();
    let clusters = 0;
    let merged = 0;
    let promoted = 0;

    for (const rec of live) {
      if (visited.has(rec._id)) continue;
      const cluster = [rec];
      visited.add(rec._id);
      for (const other of live) {
        if (visited.has(other._id)) continue;
        const d = productDistance(rec.point, other.point, this.config.weights, this.config.curvature);
        if (d < this.config.clusterEps) {
          cluster.push(other);
          visited.add(other._id);
        }
      }
      if (cluster.length > 1) clusters++;
      // Merge near-duplicates.
      const kept = [];
      for (const member of cluster) {
        const dup = kept.find((k) => productDistance(member.point, k.point, this.config.weights, this.config.curvature) < this.config.dedupEps);
        if (dup) {
          const survivor = member.lambda >= dup.lambda ? member : dup;
          const loser = survivor === member ? dup : member;
          survivor.provenance.sources = [...new Set([...(survivor.provenance.sources || []), ...(loser.provenance.sources || []), loser._id])];
          const capped = minAuthority([
            { origin: survivor.origin, actClass: survivor.actClass },
            { origin: loser.origin, actClass: loser.actClass },
          ]);
          survivor.origin = capped.origin;
          survivor.actClass = capped.actClass;
          survivor.updated = Date.now();
          this._persist(survivor);
          this._remove(loser._id);
          merged++;
          const idx = kept.indexOf(dup);
          if (idx !== -1) kept[idx] = survivor;
          continue;
        }
        kept.push(member);
      }
      // Promotion: drift survivors slightly inward (radial shrink).
      for (const member of kept) {
        if (cluster.length > 1) {
          member.point = {
            ...member.point,
            h: scale(member.point.h, 0.98),
          };
          member.updated = Date.now();
          this._persist(member);
          promoted++;
        }
      }
    }
    this._logLedger('dream', null, { clusters, merged, promoted });
    return { clusters, merged, promoted };
  }
}

module.exports = {
  // geometry
  dot, norm, scale, add, sub, clamp, normalize, zeros,
  mobiusAdd, mobiusScalar, exp0, log0, expX, logX, poincareDistance, geodesic,
  sphereDistance, slerp,
  splitEmbedding, formPoint, productDistance, transportPoint, radialDepth,
  DEFAULT_DIMS, DEFAULT_WEIGHTS, ABSTRACTION_RADII,
  // encoders
  OfflineEncoder, OllamaEncoder, OpenAIEncoder, encoderFromProvider, estimateTokens,
  // authority lattice (Law V)
  ORIGINS, ACT_CLASSES, ORIGIN_RANK, ACT_RANK, ORIGIN_ACT_CAP,
  compareAuthority, minAuthority, capActClass, authorityCovers,
  // store
  GyroMemStore, DEFAULT_CONFIG,
};
