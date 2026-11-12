# Retrieval benchmarks — GyroMem vs cosine vs BM25

Real-data retrieval benchmarks for the GyroMem memory layer
(`../gyromem.js`, `GyroMemStore`). These are **retrieval recall**
benchmarks, not end-to-end QA accuracy: there is no LLM on the
benchmark machine, so nothing here measures whether a model would
answer correctly — only whether the evidence turn ranks in the top-k.

## What's here

| File | What it does |
|---|---|
| `locomo.js` | LoCoMo (Maharana et al., ACL 2024) — 10 conversations, 5,882 turns, 1,535 scored questions (categories 1–4). Turn-level gold from the dataset's `evidence` dia_ids. |
| `longmemeval.js` | LongMemEval `s` split (Wu et al., 2024) — 500 items, ~494 turns each. Session-level gold (`answer_session_ids`); see the file header for why session-level, not turn-level. |

Both harnesses rank every question with the same four methods on the
same embeddings:

1. **geodesic** — `GyroMemStore.retrieve()` with the immune challenge
   disabled (a pure read; no mutation between questions). With uniform
   λ/authority this is pure product-manifold geodesic ranking.
2. **cosine-manifold** — cosine similarity on the *same formed manifold
   points* (concatenated `[h|s|e]`). Same representations as geodesic —
   only the metric differs. This is the paired comparison.
3. **cosine-base** — cosine on the base encoder vectors (what a plain
   vector DB would do; mirrors the S1 comparison in `../scenarios.js`).
4. **bm25** — the app's existing knowledge search
   (`KnowledgeBase.search`, one document per turn).

Metrics: recall@1/3/5/10 (any gold turn in top-k), MRR@10, and paired
first-gold-rank win/loss/tie counts for geodesic vs each other method
(also restricted to questions where at least one method found gold).

## Encoder

Default is **OfflineEncoder** — the deterministic hashed-TF fallback
inside `gyromem.js`. Set `BENCH_ENCODER=ollama` to run the same
harness against a real Ollama embedding model:

```bash
BENCH_ENCODER=ollama \
  BENCH_OLLAMA_URL=http://localhost:11434 \
  BENCH_EMBEDDING_MODEL=nomic-embed-text \
  node server/bench/locomo.js --out ~/workspace/bench-data/locomo-results-ollama.json
```

Ollama mode is **strict**: the encoder is probed once up front, and if
the probe fails the run exits with an error instead of silently falling
back to the offline encoder (a silent fallback would re-run the
offline numbers while claiming real-encoder ones). The encoder used is
recorded in the results JSON (`encoder` field) and printed at startup.
Pull the model first on the machine that runs it
(`ollama pull nomic-embed-text`).

**Long texts are truncated before embedding.** nomic-embed-text has an
8192-token context and Ollama answers an overlong embedding prompt
with HTTP 500 instead of truncating, so the network encoders truncate
each prompt to ~6000 estimated tokens (~24k chars) before sending.
The offline encoder and the BM25 corpus are NOT truncated — the
offline numbers must stay byte-identical to the published run. A
failed embedding now reports the server's own error text, not just
the bare HTTP status.

Absolute recall with the offline encoder is modest and noisy; the
meaningful result is the *paired* comparison (same embeddings,
different metric). A real encoder should change absolute numbers
substantially; whether it changes the *ordering* is the open question
the offline run does not answer.

## How to re-run

```bash
# From the repo root. Downloads are NOT vendored — fetch them first:
mkdir -p ~/workspace/bench-data
#   LoCoMo:        curl -sL -o ~/workspace/bench-data/locomo10.json \
#                    https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json
#   LongMemEval s: curl -sL -o ~/workspace/bench-data/longmemeval_s.json \
#                    https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s
# (or set BENCH_LOCOMO_PATH / BENCH_LONGMEMEVAL_PATH to your copies)

node server/bench/locomo.js [--probe] [--out <results.json>]
node server/bench/longmemeval.js [--limit N] [--out <results.json>]
```

`--probe` runs the first LoCoMo conversation only and prints three
worked examples (question, gold turn, each method's top-3) for
hand-checking the gold mapping. Results JSON contains the aggregate
tables plus per-question ranks, so any number in `bench-report.md`
can be recomputed from it.

**Use a separate `--out` file for the ollama run** (e.g.
`locomo-results-ollama.json`) — never overwrite the offline results;
the two runs are only comparable side by side.

Runtime (offline encoder, this machine, Node 24): LoCoMo full ≈ 1 min;
LongMemEval full (500 items) ≈ 15–20 min. Both are single-threaded,
zero dependencies, no network at run time.

Runtime (ollama mode): every turn is embedded twice — once inside
`GyroMemStore.index()` and once for the cosine-base baseline — so
LoCoMo makes ≈15k embedding calls (a few minutes on local Metal) and
LongMemEval ≈500k calls (roughly 1–3 hours). Run LongMemEval in the
background (`nohup ... &`) and use `--resume` if it is interrupted;
it checkpoints every 50 items.

## What the numbers mean (read before quoting)

- **Geodesic does not beat cosine here.** On LoCoMo with the offline
  encoder, geodesic trails both cosine variants on every category, and
  BM25 beats all three embedding methods. See `../../bench-report.md`
  for the tables and the honest reading.
- **Why S1's calibrated win doesn't transfer:** in S1 the win came
  from *varying* abstraction radii across records (identity 0.15,
  episodic 0.7, verbatim 0.85). In these benchmarks every record is
  indexed `episodic` (radius 0.7) and every query `query` (radius 0.5),
  so the radial channel carries zero information — geometry can only
  distort the hashed-TF signal, not inform the ranking. The honest
  conclusion is that the H1 claim is untested at real scale with a real
  encoder, not that it is disproved.
- **Some LoCoMo gold turns are textually uninformative** (e.g. a turn
  whose text is "take a look at this", pointing at an attached image).
  Text retrieval cannot rank those; they cap recall for every method.
- **Rent-gate asymmetry:** `GyroMemStore.index()` can refuse a turn
  (Law I). A refused gold turn is unretrievable by geodesic/cosine but
  still visible to BM25. The harnesses count this and report recall on
  the retrievable subset as well; in the runs so far it changed nothing
  (0 questions unretrievable on LoCoMo; 0 items on LongMemEval).
- **Not official QA accuracy.** These are not the papers' Phase 2
  evaluations: no LLM generation, no F1/accuracy judging, no
  LoCoMo/LongMemEval official scoring. Do not present recall@k as a
  benchmark score for the product.
- **Ollama re-run pending.** The offline run above is not the last word:
  the same harness now supports `BENCH_ENCODER=ollama` (see Encoder).
  Update this section with the real-encoder numbers when that run
  lands; until then, do not quote the offline ordering as the
  system's quality with real embeddings.
