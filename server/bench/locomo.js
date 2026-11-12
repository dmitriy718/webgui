'use strict';

/**
 * locomo.js — LoCoMo retrieval benchmark for GyroMem.
 *
 * Runs REAL retrieval recall on the LoCoMo dataset (Maharana et al.,
 * ACL 2024, arXiv:2402.17753; file `locomo10.json` from
 * github.com/snap-research/locomo, CC BY-NC 4.0). 10 long multi-session
 * conversations, 5,882 turns, 1,986 QA pairs with evidence pointing at
 * specific turns ("D<session>:<turn>", e.g. "D1:3").
 *
 * What is measured (retrieval only — no LLM, no generated answers):
 *   For each question, the store's turns are ranked by four methods and
 *   we check whether an evidence (gold) turn lands in the top-k:
 *
 *     geodesic       GyroMemStore.retrieve() — the Law II score. With
 *                    uniform lambda/authority this is pure product-manifold
 *                    geodesic distance ranking (challenge disabled so the
 *                    benchmark is a pure read: no mutation between questions).
 *     cosine-manifold  cosine similarity on the SAME formed manifold points
 *                    (concatenated [h|s|e] of query point vs record point).
 *                    Same representations as geodesic — only the metric
 *                    differs. This is the paired comparison the benchmark
 *                    is about.
 *     cosine-base    cosine similarity on the base encoder vectors (what a
 *                    plain vector DB would do; mirrors the S1 comparison in
 *                    server/scenarios.js). Same encoder, no manifold.
 *     bm25           the app's existing knowledge search
 *                    (KnowledgeBase.search over one document per turn).
 *
 * Gold standard: the question's `evidence` dia_ids, validated against the
 * conversation's turns (malformed / out-of-range refs dropped; questions
 * left with no valid gold refs dropped). Recall@k = 1 if ANY gold turn is
 * in the top-k. MRR@10 over the first gold rank (11 = not in top-10).
 *
 * Scope (standard LoCoMo protocol): categories 1-4 (1,540 questions).
 * Category 5 (446 adversarial / unanswerable questions) is excluded —
 * those have no gold answer by design; retrieval recall is undefined for
 * them. Category ids in the file (per the upstream evaluation code):
 *   1 = multi-hop (282), 2 = temporal (321), 3 = open-domain (96),
 *   4 = single-hop (841), 5 = adversarial (446).
 *
 * Encoder: OfflineEncoder (deterministic hashed TF) by default — see
 * server/bench/encoder.js. Set BENCH_ENCODER=ollama (with
 * BENCH_OLLAMA_URL / BENCH_EMBEDDING_MODEL) to run the same harness
 * against a real Ollama embedding model; ollama mode is strict and
 * refuses to run if the probe fails, so it can never silently
 * reproduce offline numbers. Absolute recall will be modest and noisy
 * with the offline encoder; the meaningful result is the PAIRED
 * comparison (same embeddings, different metric).
 *
 * IMPORTANT asymmetry, reported, not hidden: GyroMemStore.index() has a
 * Law I rent gate that can REFUSE a turn. A refused gold turn can never
 * be retrieved by geodesic/cosine (it is not in the store), while BM25
 * still sees it (the knowledge base indexes every turn). The report
 * therefore gives recall both overall and on the "retrievable" subset
 * (questions with >= 1 admitted gold turn).
 *
 * Usage:
 *   node server/bench/locomo.js [--probe] [--out <path>]
 *     --probe   first conversation only + prints 3 worked examples
 *     --out     per-question results JSON (default:
 *               ~/workspace/bench-data/locomo-results.json)
 *
 * Dataset path: env BENCH_LOCOMO_PATH, default
 *   ~/workspace/bench-data/locomo10.json
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const g = require('../gyromem');
const { KnowledgeBase } = require('../knowledge');
const { StoreManager } = require('../store');
const { resolveBenchEncoder } = require('./encoder');

const DEFAULT_DATA = path.join(os.homedir(), 'workspace', 'bench-data', 'locomo10.json');
const LOCOMO_PATH = process.env.BENCH_LOCOMO_PATH || DEFAULT_DATA;

const CATEGORY_LABELS = {
  1: 'multi-hop',
  2: 'temporal',
  3: 'open-domain',
  4: 'single-hop',
  5: 'adversarial',
};

const K = 10; // retrieval depth for all methods

// ---------------------------------------------------------------------------
// In-memory Store-compatible collection (no disk writes — benchmark speed).
// GyroMemStore only needs all()/get()/insert()/replace()/delete().
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Dataset loading + validation
// ---------------------------------------------------------------------------
function loadLocomo(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const conversations = [];
  const dropped = { malformedEvidence: 0, noValidGold: 0, adversarial: 0, outOfRange: 0 };

  for (const conv of raw) {
    const c = conv.conversation || {};
    const turns = [];
    const turnByDia = new Map();
    const sessionKeys = Object.keys(c)
      .filter((k) => /^session_\d+$/.test(k))
      .sort((a, b) => parseInt(a.slice(8), 10) - parseInt(b.slice(8), 10));
    for (const key of sessionKeys) {
      const sessionNo = parseInt(key.slice(8), 10);
      const list = c[key] || [];
      list.forEach((t, i) => {
        // dia_id is authoritative when present; fall back to D<session>:<i+1>.
        const diaId = typeof t.dia_id === 'string' && t.dia_id ? t.dia_id : `D${sessionNo}:${i + 1}`;
        const turn = {
          diaId,
          session: sessionNo,
          turnIndex: i + 1,
          speaker: t.speaker || '',
          text: String(t.text || ''),
        };
        turns.push(turn);
        turnByDia.set(diaId, turn);
      });
    }

    const questions = [];
    for (const q of conv.qa || []) {
      if (q.category === 5) {
        dropped.adversarial += 1;
        continue; // standard protocol: adversarial has no gold answer
      }
      // Parse evidence refs defensively: extract every D<session>:<turn>.
      const gold = [];
      for (const ref of q.evidence || []) {
        const matches = String(ref).match(/D\d+:\d+/g) || [];
        for (const m of matches) {
          if (turnByDia.has(m)) gold.push(m);
          else dropped.outOfRange += 1;
        }
        if (matches.length === 0) dropped.malformedEvidence += 1;
      }
      const uniqueGold = [...new Set(gold)];
      if (uniqueGold.length === 0) {
        dropped.noValidGold += 1;
        continue;
      }
      questions.push({
        question: String(q.question || ''),
        answer: q.answer === undefined ? '' : String(q.answer),
        category: q.category,
        gold: uniqueGold,
      });
    }
    conversations.push({
      sampleId: conv.sample_id || 'unknown',
      turns,
      turnByDia,
      questions,
    });
  }
  return { conversations, dropped, totalRawQa: raw.reduce((s, c) => s + (c.qa || []).length, 0) };
}

// ---------------------------------------------------------------------------
// Ranking helpers (reuse gyromem.js internals; nothing reimplemented)
// ---------------------------------------------------------------------------
function cosine(a, b) {
  const n = g.norm(a) * g.norm(b);
  return n === 0 ? 0 : g.dot(a, b) / n;
}

function concatPoint(p) {
  return [...p.h, ...p.s, ...p.e];
}

/** Rank a question by each method; returns { method: [diaId...top K] }. */
async function rankAll(memory, kb, baseVecs, question) {
  // geodesic (Law II score; uniform lambda/authority => pure geodesic)
  const geoHits = await memory.retrieve(question, { k: K, challenge: false });
  const geodesic = geoHits.map((h) => h.record.docId);

  // cosine on the same formed manifold points
  const qPoint = await memory.encodeQuery(question);
  const qFlat = concatPoint(qPoint);
  const cosManifold = memory
    .liveRecords()
    .map((rec) => ({ id: rec.docId, s: cosine(qFlat, concatPoint(rec.point)) }))
    .sort((a, z) => z.s - a.s)
    .slice(0, K)
    .map((r) => r.id);

  // cosine on the base encoder vectors (plain vector-DB baseline, cf. S1)
  const qVec = await memory.encoder.embedOne(question);
  const cosBase = [...baseVecs.entries()]
    .map(([id, vec]) => ({ id, s: cosine(qVec, vec) }))
    .sort((a, z) => z.s - a.s)
    .slice(0, K)
    .map((r) => r.id);

  // BM25: the app's knowledge search (one document per turn)
  const bm25 = kb.search(question, { k: K }).map((r) => r.docTitle);

  return { geodesic, 'cosine-manifold': cosManifold, 'cosine-base': cosBase, bm25 };
}

function firstGoldRank(ranked, goldSet) {
  for (let i = 0; i < ranked.length; i++) {
    if (goldSet.has(ranked[i])) return i + 1;
  }
  return K + 1; // not in top-K
}

// ---------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------
async function runConversation(conv, { printExamples = false, benchEncoder = null } = {}) {
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
  for (const turn of conv.turns) {
    const res = await memory.index(turn.diaId, turn.turnIndex, turn.text, {
      origin: 'user',
      abstraction: 'episodic',
    });
    if (res.admitted) {
      baseVecs.set(turn.diaId, await memory.encoder.embedOne(turn.text));
    } else {
      refused.push(turn.diaId);
    }
  }
  const indexMs = Date.now() - t0;

  // Knowledge base: one document per turn, temp dir (matches app usage).
  // Skip empty turns: KnowledgeBase.addDocument() throws on empty content.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'locomo-bench-kb-'));
  const sm = new StoreManager(tmpDir);
  const kb = new KnowledgeBase(sm.collection('documents'));
  for (const turn of conv.turns) {
    if (!turn.text.trim()) continue;
    kb.addDocument({ title: turn.diaId, content: turn.text });
  }

  const refusedSet = new Set(refused);
  const results = [];
  const examples = [];
  const q0 = Date.now();
  for (let qi = 0; qi < conv.questions.length; qi++) {
    const q = conv.questions[qi];
    const goldSet = new Set(q.gold);
    const ranked = await rankAll(memory, kb, baseVecs, q.question);
    const ranks = {};
    for (const m of ['geodesic', 'cosine-manifold', 'cosine-base', 'bm25']) {
      ranks[m] = firstGoldRank(ranked[m], goldSet);
    }
    const admittedGold = q.gold.filter((id) => !refusedSet.has(id));
    results.push({
      sampleId: conv.sampleId,
      question: q.question,
      answer: q.answer,
      category: q.category,
      gold: q.gold,
      retrievable: admittedGold.length > 0,
      ranks,
    });
    if (printExamples && examples.length < 3) {
      examples.push({ q, ranked });
    }
  }
  const queryMs = Date.now() - q0;
  fs.rmSync(tmpDir, { recursive: true, force: true });

  return {
    sampleId: conv.sampleId,
    turns: conv.turns.length,
    questions: conv.questions.length,
    admitted: memory.count(),
    refused: refused.length,
    refusedGoldTurns: conv.questions.reduce(
      (s, q) => s + q.gold.filter((id) => refusedSet.has(id)).length,
      0
    ),
    questionsWithRefusedGold: conv.questions.filter((q) =>
      q.gold.some((id) => refusedSet.has(id))
    ).length,
    questionsUnretrievable: conv.questions.filter((q) =>
      q.gold.every((id) => refusedSet.has(id))
    ).length,
    indexMs,
    queryMs,
    results,
    examples,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------
function aggregate(results) {
  const methods = ['geodesic', 'cosine-manifold', 'cosine-base', 'bm25'];
  const byMethod = {};
  for (const m of methods) {
    byMethod[m] = { recall: { 1: 0, 3: 0, 5: 0, 10: 0 }, mrr: 0, n: 0 };
  }
  let paired = {
    'geo-vs-cosM': { win: 0, loss: 0, tie: 0 },
    'geo-vs-cosB': { win: 0, loss: 0, tie: 0 },
    'geo-vs-bm25': { win: 0, loss: 0, tie: 0 },
  };
  const byCategory = {};
  let retrievable = 0;
  // Paired counts restricted to questions where at least one of the two
  // methods found gold in top-K (otherwise "tie" is mostly "both missed").
  const pairedHits = {
    'geo-vs-cosM': { win: 0, loss: 0, tie: 0, n: 0 },
    'geo-vs-cosB': { win: 0, loss: 0, tie: 0, n: 0 },
    'geo-vs-bm25': { win: 0, loss: 0, tie: 0, n: 0 },
  };

  for (const r of results) {
    if (r.retrievable) retrievable++;
    const cat = r.category;
    if (!byCategory[cat]) byCategory[cat] = { n: 0, perMethod: {} };
    byCategory[cat].n++;
    for (const m of methods) {
      const rank = r.ranks[m];
      const a = byMethod[m];
      a.n++;
      if (rank <= 1) a.recall[1]++;
      if (rank <= 3) a.recall[3]++;
      if (rank <= 5) a.recall[5]++;
      if (rank <= 10) a.recall[10]++;
      if (rank <= K) a.mrr += 1 / rank;
      const c = (byCategory[cat].perMethod[m] = byCategory[cat].perMethod[m] || {
        recall5: 0,
        recall10: 0,
        n: 0,
      });
      c.n++;
      if (rank <= 5) c.recall5++;
      if (rank <= 10) c.recall10++;
    }
    const cmp = (a, b) => (a < b ? 'win' : a > b ? 'loss' : 'tie');
    paired['geo-vs-cosM'][cmp(r.ranks.geodesic, r.ranks['cosine-manifold'])]++;
    paired['geo-vs-cosB'][cmp(r.ranks.geodesic, r.ranks['cosine-base'])]++;
    paired['geo-vs-bm25'][cmp(r.ranks.geodesic, r.ranks.bm25)]++;
    const cmpHit = (key, a, b) => {
      if (a > K && b > K) return; // both missed: uninformative, skip
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
  return { byMethod, paired, pairedHits, byCategory, retrievable, n: results.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const probe = args.includes('--probe');
  const outIdx = args.indexOf('--out');
  const outPath =
    outIdx !== -1 && args[outIdx + 1]
      ? args[outIdx + 1]
      : path.join(os.homedir(), 'workspace', 'bench-data', 'locomo-results.json');

  const tStart = Date.now();
  // Resolve the encoder FIRST: ollama mode fails loudly here if the
  // probe fails, so a bad config dies before any dataset work.
  const benchEncoder = await resolveBenchEncoder();
  console.log(`Encoder: ${benchEncoder.label}`);
  console.log(`Loading LoCoMo from ${LOCOMO_PATH} ...`);
  const { conversations, dropped, totalRawQa } = loadLocomo(LOCOMO_PATH);
  const totalTurns = conversations.reduce((s, c) => s + c.turns.length, 0);
  console.log(
    `Loaded ${conversations.length} conversations, ${totalTurns} turns, ` +
      `${totalRawQa} raw QA. Dropped: adversarial=${dropped.adversarial}, ` +
      `no-valid-gold=${dropped.noValidGold}, malformed-evidence-refs=${dropped.malformedEvidence}, ` +
      `out-of-range-refs=${dropped.outOfRange}.`
  );

  const subset = probe ? conversations.slice(0, 1) : conversations;
  const allResults = [];
  const perConv = [];
  for (const conv of subset) {
    console.log(`-- ${conv.sampleId}: ${conv.turns.length} turns, ${conv.questions.length} questions`);
    const r = await runConversation(conv, { printExamples: probe, benchEncoder });
    perConv.push({
      sampleId: r.sampleId,
      turns: r.turns,
      questions: r.questions,
      admitted: r.admitted,
      refused: r.refused,
      refusedGoldTurns: r.refusedGoldTurns,
      questionsWithRefusedGold: r.questionsWithRefusedGold,
      questionsUnretrievable: r.questionsUnretrievable,
      indexMs: r.indexMs,
      queryMs: r.queryMs,
    });
    allResults.push(...r.results);
    if (probe) {
      for (const ex of r.examples) {
        console.log(`\nEXAMPLE — Q: ${ex.q.question}`);
        console.log(`  answer: ${ex.q.answer} | gold: ${ex.q.gold.join(', ')}`);
        for (const turn of conv.turns.filter((t) => ex.q.gold.includes(t.diaId))) {
          console.log(`  GOLD TURN [${turn.diaId}] ${turn.speaker}: ${turn.text}`);
        }
        for (const m of ['geodesic', 'cosine-manifold', 'cosine-base', 'bm25']) {
          console.log(`  ${m} top-3: ${ex.ranked[m].slice(0, 3).join(', ')}`);
          for (const id of ex.ranked[m].slice(0, 3)) {
            const t = conv.turnByDia.get(id);
            if (t) console.log(`      [${id}] ${t.speaker}: ${t.text.slice(0, 110)}`);
          }
        }
      }
      console.log(`\nprobe timing: index ${r.indexMs}ms, questions ${r.queryMs}ms for ${r.questions} questions`);
    }
  }

  const agg = aggregate(allResults);
  // Retrievable-subset aggregation (questions with >= 1 admitted gold turn).
  const retrievableAgg = aggregate(allResults.filter((r) => r.retrievable));

  const totalMs = Date.now() - tStart;
  const report = {
    dataset: 'LoCoMo (locomo10.json)',
    source: 'github.com/snap-research/locomo (data/locomo10.json), CC BY-NC 4.0; paper Maharana et al. ACL 2024, arXiv:2402.17753',
    categories: '1-4 only (standard protocol; cat 5 adversarial excluded)',
    encoder: benchEncoder.label,
    methods: ['geodesic', 'cosine-manifold', 'cosine-base', 'bm25'],
    k: K,
    conversations: subset.map((c) => c.sampleId),
    totalTurns,
    totalQuestions: allResults.length,
    dropped,
    perConversation: perConv,
    aggregate: agg,
    aggregateRetrievableOnly: retrievableAgg,
    runtimeMs: totalMs,
    generatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ ...report, results: allResults }, null, 2));

  console.log('\n=== LoCoMo retrieval recall (n=' + allResults.length + ') ===');
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
  console.log('Paired, restricted to questions where at least one method found gold in top-10:');
  for (const [k, v] of Object.entries(agg.pairedHits)) {
    console.log(`  ${k}: n=${v.n} win ${v.win}, loss ${v.loss}, tie ${v.tie}`);
  }
  console.log(`\nRent-gate refusals: ${perConv.reduce((s, c) => s + c.refused, 0)} turns refused of ${totalTurns}; ` +
    `${perConv.reduce((s, c) => s + c.questionsUnretrievable, 0)} questions have NO admitted gold turn.`);
  console.log(`Total runtime: ${(totalMs / 1000).toFixed(1)}s. Results written to ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { loadLocomo, runConversation, aggregate, CATEGORY_LABELS };
