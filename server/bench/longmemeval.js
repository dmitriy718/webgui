'use strict';

/**
 * longmemeval.js — LongMemEval retrieval benchmark for GyroMem.
 *
 * Data: `longmemeval_s.json` from HF xiaowu0162/longmemeval (deprecated
 * in favour of longmemeval-cleaned; the `s` split is the full small
 * history version), 500 QA items. Each item has ~50 haystack sessions
 * (~494 turns) of which ~1.9 are the answer (evidence) sessions.
 * Paper: Wu et al. 2024, "LongMemEval: Benchmarking Chat Assistants on
 * Long-Term Interactive Memory" (arXiv:2410.10813). MIT license.
 *
 * Why session-level gold here: LongMemEval marks evidence at SESSION
 * granularity (`answer_session_ids`). A retrieved turn is gold iff its
 * session is an answer session. This is the session-level retrieval
 * granularity the LongMemEval paper itself uses; turn-level gold is not
 * annotated, so inventing it (e.g. by answer-string matching) would bias
 * the benchmark toward lexical methods. Session-level recall is unbiased
 * across methods.
 *
 * Methods: identical to server/bench/locomo.js — geodesic
 * (GyroMemStore.retrieve, challenge off), cosine-manifold (same formed
 * points, cosine metric), cosine-base (base encoder vectors), BM25 (the
 * app's KnowledgeBase.search over one document per turn). One question
 * per item; corpus = that item's full haystack.
 *
 * Difference from locomo.js: the knowledge base uses a Store subclass
 * with persistence disabled (FastStore) — 500 items x ~494 documents
 * would otherwise rewrite the JSON collection on every insert. The
 * retrieval code path is identical (same search/chunkText/buildIndex/
 * bm25Search); only disk writes are skipped. Documented here, not hidden.
 *
 * Encoder: OfflineEncoder by default; BENCH_ENCODER=ollama (see
 * server/bench/encoder.js) runs the same harness against a real Ollama
 * embedding model (strict: refuses to run if the probe fails).
 *
 * Usage:
 *   node server/bench/longmemeval.js [--limit N] [--out <path>] [--resume <path>]
 *     --resume <path>  pick up from a checkpointed (complete:false)
 *                      results file after an interrupted run.
 *
 * Dataset path: env BENCH_LONGMEMEVAL_PATH, default
 *   ~/workspace/bench-data/longmemeval_s.json
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const g = require('../gyromem');
const { KnowledgeBase } = require('../knowledge');
const { StoreManager, Store } = require('../store');
const { resolveBenchEncoder } = require('./encoder');

const DEFAULT_DATA = path.join(os.homedir(), 'workspace', 'bench-data', 'longmemeval_s.json');
const LONGMEMEVAL_PATH = process.env.BENCH_LONGMEMEVAL_PATH || DEFAULT_DATA;

const K = 10;

/** Store with persistence disabled (memory-only) for benchmark speed. */
class FastStore extends Store {
  _persist() {
    /* no disk writes: retrieval logic identical, inserts are Map sets */
  }
}

class MemCollection {
  constructor() {
    this._map = new Map();
  }
  all() {
    return [...this._map.values()].map((d) => JSON.parse(JSON.stringify(d)));
  }
  get(id) {
    const d = this._map.get(id);
    return d ? JSON.parse(JSON.stringify(d)) : null;
  }
  insert(doc) {
    const d = { ...doc };
    if (typeof d._id !== 'string' || !d._id) d._id = `mem-${this._map.size}`;
    this._map.set(d._id, d);
    return JSON.parse(JSON.stringify(d));
  }
  replace(doc) {
    if (!this._map.has(doc._id)) return null;
    const cur = this._map.get(doc._id);
    const next = { ...cur, ...doc };
    this._map.set(doc._id, next);
    return JSON.parse(JSON.stringify(next));
  }
  delete(id) {
    return this._map.delete(id);
  }
}

function loadLongMemEval(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return raw.map((item) => {
    const turns = [];
    const sessions = item.haystack_sessions || [];
    const ids = item.haystack_session_ids || [];
    sessions.forEach((session, si) => {
      const sessionId = ids[si] || `session_${si}`;
      (session || []).forEach((t, ti) => {
        turns.push({
          diaId: `${sessionId}#${ti + 1}`,
          sessionId,
          speaker: t.role || '',
          text: String(t.content || ''),
        });
      });
    });
    return {
      questionId: item.question_id || '',
      question: String(item.question || ''),
      answer: item.answer === undefined ? '' : String(item.answer),
      type: item.question_type || '',
      turns,
      answerSessionIds: new Set(item.answer_session_ids || []),
      sessionCount: sessions.length,
    };
  });
}

function cosine(a, b) {
  const n = g.norm(a) * g.norm(b);
  return n === 0 ? 0 : g.dot(a, b) / n;
}

function concatPoint(p) {
  return [...p.h, ...p.s, ...p.e];
}

async function rankAll(memory, kb, baseVecs, question) {
  const geoHits = await memory.retrieve(question, { k: K, challenge: false });
  const geodesic = geoHits.map((h) => h.record.docId);

  const qPoint = await memory.encodeQuery(question);
  const qFlat = concatPoint(qPoint);
  const cosManifold = memory
    .liveRecords()
    .map((rec) => ({ id: rec.docId, s: cosine(qFlat, concatPoint(rec.point)) }))
    .sort((a, z) => z.s - a.s)
    .slice(0, K)
    .map((r) => r.id);

  const qVec = await memory.encoder.embedOne(question);
  const cosBase = [...baseVecs.entries()]
    .map(([id, vec]) => ({ id, s: cosine(qVec, vec) }))
    .sort((a, z) => z.s - a.s)
    .slice(0, K)
    .map((r) => r.id);

  const bm25 = kb.search(question, { k: K }).map((r) => r.docTitle);

  return { geodesic, 'cosine-manifold': cosManifold, 'cosine-base': cosBase, bm25 };
}

function firstGoldRank(ranked, isGold) {
  for (let i = 0; i < ranked.length; i++) {
    if (isGold(ranked[i])) return i + 1;
  }
  return K + 1;
}

async function runItem(item, benchEncoder = null) {
  const t0 = Date.now();
  const memory = new g.GyroMemStore(new MemCollection(), null);
  // A resolved bench encoder (offline default; ollama when
  // BENCH_ENCODER=ollama) is shared across the run's stores.
  if (benchEncoder && benchEncoder.encoder) {
    memory.encoder = benchEncoder.encoder;
    memory.encoderKind = benchEncoder.kind;
  }
  const baseVecs = new Map();
  const refused = [];
  const sessionOf = new Map();
  for (const turn of item.turns) {
    sessionOf.set(turn.diaId, turn.sessionId);
    const res = await memory.index(turn.diaId, 0, turn.text, {
      origin: 'user',
      abstraction: 'episodic',
    });
    if (res.admitted) baseVecs.set(turn.diaId, await memory.encoder.embedOne(turn.text));
    else refused.push(turn.diaId);
  }
  const indexMs = Date.now() - t0;

  // Knowledge base on a FastStore (persistence disabled; retrieval identical).
  // Skip empty turns: GyroMemStore.index() refuses them (Law I), and
  // KnowledgeBase.addDocument() throws on empty content — skipping keeps
  // the two corpora aligned (an empty turn is retrievable by no method).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'longmemeval-bench-kb-'));
  const docs = new FastStore(tmpDir, 'documents');
  const kb = new KnowledgeBase(docs);
  let kbSkipped = 0;
  for (const turn of item.turns) {
    if (!turn.text.trim()) {
      kbSkipped++;
      continue;
    }
    kb.addDocument({ title: turn.diaId, content: turn.text });
  }

  const isGold = (diaId) => item.answerSessionIds.has(sessionOf.get(diaId));
  const q0 = Date.now();
  const ranked = await rankAll(memory, kb, baseVecs, item.question);
  const queryMs = Date.now() - q0;
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const ranks = {};
  for (const m of ['geodesic', 'cosine-manifold', 'cosine-base', 'bm25']) {
    ranks[m] = firstGoldRank(ranked[m], isGold);
  }
  const goldTurns = item.turns.filter((t) => item.answerSessionIds.has(t.sessionId));
  const retrievable = goldTurns.some((t) => !refused.includes(t.diaId));
  return {
    questionId: item.questionId,
    question: item.question,
    answer: item.answer,
    type: item.type,
    turns: item.turns.length,
    sessions: item.sessionCount,
    answerSessions: item.answerSessionIds.size,
    goldTurns: goldTurns.length,
    retrievable,
    refused: refused.length,
    kbSkipped,
    indexMs,
    queryMs,
    ranks,
  };
}

function aggregate(results) {
  const methods = ['geodesic', 'cosine-manifold', 'cosine-base', 'bm25'];
  const byMethod = {};
  for (const m of methods) {
    byMethod[m] = { recall: { 1: 0, 3: 0, 5: 0, 10: 0 }, mrr: 0, n: 0 };
  }
  const paired = {
    'geo-vs-cosM': { win: 0, loss: 0, tie: 0 },
    'geo-vs-cosB': { win: 0, loss: 0, tie: 0 },
    'geo-vs-bm25': { win: 0, loss: 0, tie: 0 },
  };
  const pairedHits = {
    'geo-vs-cosM': { win: 0, loss: 0, tie: 0, n: 0 },
    'geo-vs-cosB': { win: 0, loss: 0, tie: 0, n: 0 },
    'geo-vs-bm25': { win: 0, loss: 0, tie: 0, n: 0 },
  };
  const byType = {};
  const cmp = (a, b) => (a < b ? 'win' : a > b ? 'loss' : 'tie');
  for (const r of results) {
    const t = r.type;
    if (!byType[t]) byType[t] = { n: 0, perMethod: {} };
    byType[t].n++;
    for (const m of methods) {
      const rank = r.ranks[m];
      const a = byMethod[m];
      a.n++;
      if (rank <= 1) a.recall[1]++;
      if (rank <= 3) a.recall[3]++;
      if (rank <= 5) a.recall[5]++;
      if (rank <= 10) a.recall[10]++;
      if (rank <= K) a.mrr += 1 / rank;
      const c = (byType[t].perMethod[m] = byType[t].perMethod[m] || { recall5: 0, recall10: 0, n: 0 });
      c.n++;
      if (rank <= 5) c.recall5++;
      if (rank <= 10) c.recall10++;
    }
    paired['geo-vs-cosM'][cmp(r.ranks.geodesic, r.ranks['cosine-manifold'])]++;
    paired['geo-vs-cosB'][cmp(r.ranks.geodesic, r.ranks['cosine-base'])]++;
    paired['geo-vs-bm25'][cmp(r.ranks.geodesic, r.ranks.bm25)]++;
    const cmpHit = (key, a, b) => {
      if (a > K && b > K) return;
      pairedHits[key].n++;
      pairedHits[key][cmp(a, b)]++;
    };
    cmpHit('geo-vs-cosM', r.ranks.geodesic, r.ranks['cosine-manifold']);
    cmpHit('geo-vs-cosB', r.ranks.geodesic, r.ranks['cosine-base']);
    cmpHit('geo-vs-bm25', r.ranks.geodesic, r.ranks.bm25);
  }
  for (const m of methods) {
    const a = byMethod[m];
    for (const k of [1, 3, 5, 10]) a.recall[k] = a.n ? a.recall[k] / a.n : 0;
    a.mrr = a.n ? a.mrr / a.n : 0;
  }
  return { byMethod, paired, pairedHits, byType, n: results.length };
}

function buildReport(results, { totalTurns, refusedTotal, unretrievable, totalMs, complete, encoderLabel }) {
  const agg = aggregate(results);
  return {
    dataset: 'LongMemEval (longmemeval_s split)',
    source: 'HF xiaowu0162/longmemeval (deprecated; superseded by longmemeval-cleaned), MIT; paper Wu et al. 2024, arXiv:2410.10813',
    gold: 'session-level: a retrieved turn is gold iff its session is in answer_session_ids',
    encoder: encoderLabel,
    methods: ['geodesic', 'cosine-manifold', 'cosine-base', 'bm25'],
    k: K,
    complete,
    totalItems: results.length,
    totalTurns,
    refusedTotal,
    unretrievable,
    aggregate: agg,
    runtimeMs: totalMs,
    generatedAt: new Date().toISOString(),
    results,
  };
}

function writeCheckpoint(outPath, report) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;
  const outIdx = args.indexOf('--out');
  const outPath =
    outIdx !== -1 && args[outIdx + 1]
      ? args[outIdx + 1]
      : path.join(os.homedir(), 'workspace', 'bench-data', 'longmemeval-results.json');
  // --resume <path>: pick up from a checkpointed (complete:false) results
  // file written by an interrupted run. The same file is used as the
  // checkpoint target, so re-running the same command with --resume
  // pointing at the out path resumes in place.
  const resumeIdx = args.indexOf('--resume');
  const resumePath = resumeIdx !== -1 ? args[resumeIdx + 1] : null;

  const tStart = Date.now();
  // Resolve the encoder FIRST: ollama mode fails loudly here if the
  // probe fails, so a bad config dies before any dataset work.
  const benchEncoder = await resolveBenchEncoder();
  console.log(`Encoder: ${benchEncoder.label}`);
  console.log(`Loading LongMemEval (s split) from ${LONGMEMEVAL_PATH} ...`);
  const items = loadLongMemEval(LONGMEMEVAL_PATH);
  const totalTurns = items.reduce((s, i) => s + i.turns.length, 0);
  console.log(`Loaded ${items.length} items, ${totalTurns} turns total ` +
    `(mean ${(totalTurns / items.length).toFixed(1)} turns/item).`);

  const subset = items.slice(0, limit);
  const results = [];
  let refusedTotal = 0;
  let unretrievable = 0;
  if (resumePath) {
    const partial = JSON.parse(fs.readFileSync(resumePath, 'utf8'));
    for (const r of partial.results || []) results.push(r);
    refusedTotal = partial.refusedTotal || 0;
    unretrievable = partial.unretrievable || 0;
    console.log(`Resumed from ${resumePath}: ${results.length} items already done, ` +
      `${subset.length - results.length} to go.`);
  }
  const doneIds = new Set(results.map((r) => r.questionId));
  for (let i = 0; i < subset.length; i++) {
    const item = subset[i];
    if (doneIds.has(item.questionId)) continue;
    const r = await runItem(item, benchEncoder);
    results.push(r);
    refusedTotal += r.refused;
    if (!r.retrievable) unretrievable++;
    if (results.length % 50 === 0) {
      const partial = buildReport(results, {
        totalTurns,
        refusedTotal,
        unretrievable,
        totalMs: Date.now() - tStart,
        complete: false,
        encoderLabel: benchEncoder.label,
      });
      writeCheckpoint(outPath, partial);
      console.log(`  ... ${results.length}/${subset.length} items checkpointed (${((Date.now() - tStart) / 1000).toFixed(0)}s)`);
    }
  }

  const totalMs = Date.now() - tStart;
  const report = buildReport(results, { totalTurns, refusedTotal, unretrievable, totalMs, complete: true, encoderLabel: benchEncoder.label });
  writeCheckpoint(outPath, report);
  const agg = report.aggregate;

  console.log(`\n=== LongMemEval session-level recall (n=${results.length}) ===`);
  console.log('method           R@1     R@3     R@5     R@10    MRR@10');
  for (const m of ['geodesic', 'cosine-manifold', 'cosine-base', 'bm25']) {
    const a = agg.byMethod[m];
    console.log(
      `${m.padEnd(16)} ${(a.recall[1] * 100).toFixed(1).padStart(5)}% ${(a.recall[3] * 100).toFixed(1).padStart(5)}% ` +
        `${(a.recall[5] * 100).toFixed(1).padStart(5)}% ${(a.recall[10] * 100).toFixed(1).padStart(5)}%  ${a.mrr.toFixed(3)}`
    );
  }
  console.log('\nPaired first-gold-rank (geodesic vs ...): win = geodesic ranks gold higher');
  for (const [k, v] of Object.entries(agg.paired)) {
    console.log(`  ${k}: win ${v.win}, loss ${v.loss}, tie ${v.tie}`);
  }
  console.log('Paired, restricted to items where at least one method found gold in top-10:');
  for (const [k, v] of Object.entries(agg.pairedHits)) {
    console.log(`  ${k}: n=${v.n} win ${v.win}, loss ${v.loss}, tie ${v.tie}`);
  }
  console.log(`\nRent-gate refusals: ${refusedTotal} turns; ${unretrievable} items with NO admitted gold turn.`);
  console.log(`Total runtime: ${(totalMs / 1000).toFixed(1)}s. Results written to ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { loadLongMemEval, runItem, aggregate };
