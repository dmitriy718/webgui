# GyroMem retrieval benchmark — honest numbers

**Date:** 2026-11-12 (run overnight, before the Show HN post)
**Code:** `server/bench/` (`locomo.js`, `longmemeval.js`, `README.md`)
**Raw per-question results:** `~/workspace/bench-data/locomo-results.json`,
`~/workspace/bench-data/longmemeval-results.json` (recompute any number here from those files)

This is a **retrieval recall** benchmark, not end-to-end QA accuracy.
There is no LLM on the benchmark machine, so nothing here measures
whether a model would answer correctly — only whether the evidence
turn ranks in the top-k for a question.

## Headline finding (say it plainly)

**Geodesic retrieval does NOT beat cosine on real data with the
offline encoder. It loses clearly on both datasets overall.**
On LoCoMo it trails both cosine variants in every category; on
LongMemEval it trails overall and loses to cosine-base in all six
question types (the only exceptions are two small-n LongMemEval
subtypes where it edges cosine-manifold — see below). BM25 beats all
three embedding methods on both datasets. The scenario S1 result
(geodesic correcting a cosine error on a small calibrated corpus)
does not generalize to real conversations with this encoder. That is
a finding, not a failure — and it is exactly why the Show HN post
must keep saying benchmarks are not run yet *with a real encoder*.
What changed tonight: we now have real retrieval numbers with the
offline encoder, and they do not flatter the geometry.

## Setup (same for both datasets)

- **Encoder:** `OfflineEncoder` — the deterministic hashed-TF fallback
  inside `server/gyromem.js`. It is explicitly **not** a learned model.
  Absolute recall is modest and noisy; the meaningful result is the
  **paired** comparison (same embeddings, different metric).
- **Methods** (four rankings per question, same embeddings):
  1. **geodesic** — `GyroMemStore.retrieve()` with the immune challenge
     disabled (pure read, no mutation between questions). With uniform
     λ/authority this is pure product-manifold geodesic ranking.
  2. **cosine-manifold** — cosine similarity on the *same formed
     manifold points* (concatenated `[h|s|e]`). Same representations as
     geodesic — only the metric differs.
  3. **cosine-base** — cosine on the base encoder vectors (what a plain
     vector DB would do; mirrors the S1 comparison in
     `server/scenarios.js`).
  4. **bm25** — the app's existing knowledge search
     (`KnowledgeBase.search`, one document per turn).
- **Metric:** recall@1/3/5/10 (is ANY gold turn in the top-k?) and
  MRR@10. Paired win/loss/tie counts compare first-gold rank for
  geodesic vs each other method; the "hits" variant restricts to
  questions where at least one of the two methods found gold in
  top-10 (otherwise "tie" is mostly "both missed").
- **Indexing:** every turn indexed as a GyroMem record, origin
  `user`, abstraction `episodic` — exactly how `knowledge.js`
  indexes documents. One store per conversation (LoCoMo) / per item
  (LongMemEval).
- **No LLM calls, no network at run time.** Deterministic: the same
  run reproduces the same numbers.

## LoCoMo

**Dataset:** `locomo10.json` from github.com/snap-research/locomo
(CC BY-NC 4.0; Maharana et al., ACL 2024, arXiv:2402.17753).
10 conversations, **5,882 turns**, **1,986 QA pairs**.
Gold: the dataset's `evidence` dia_ids (e.g. `D1:3`), validated
against the conversation's turns.

**Scope:** categories 1–4 only — **1,535 questions** (standard LoCoMo
protocol). Category 5 (446 adversarial / unanswerable questions) is
excluded: those have no gold answer by design, so retrieval recall is
undefined for them. Category ids in the file (per the upstream
evaluation code): 1 = multi-hop (282), 2 = temporal (321),
3 = open-domain (96), 4 = single-hop (841), 5 = adversarial (446).

**Dropped during validation:** 5 questions with no valid gold ref
(2 evidence refs were unparseable — e.g. `D`, `D:11:26` — and 3
refs pointed at turns that do not exist). Full counts in the results
JSON.

**Runtime:** 58.2 s (Node 24, this VM).

### Recall@k and MRR@10 (n = 1,535)

| method | R@1 | R@3 | R@5 | R@10 | MRR@10 |
|---|---|---|---|---|---|
| **geodesic** | 2.1% | 5.3% | 8.3% | 14.1% | 0.048 |
| cosine-manifold | 5.3% | 12.1% | 16.3% | 22.9% | 0.101 |
| cosine-base | 8.7% | 14.0% | 17.3% | 23.9% | 0.127 |
| bm25 | 19.0% | 30.4% | 36.5% | 44.8% | 0.265 |

### Paired first-gold-rank (geodesic vs …)

| comparison | win | loss | tie | (hits-only subset) |
|---|---|---|---|---|
| geo vs cosine-manifold | 114 | 300 | 1,121 | n=434: win 114, loss 300, tie 20 |
| geo vs cosine-base | 65 | 288 | 1,182 | n=393: win 65, loss 288, tie 40 |
| geo vs bm25 | 63 | 640 | 832 | n=728: win 63, loss 640, tie 25 |

"win" = geodesic ranks the gold turn higher. On the questions where
either method found gold, geodesic loses to cosine-manifold 300–114
and to cosine-base 288–65. The overall tie counts are dominated by
questions where *both* methods missed the top-10 — hence the
hits-only column, which is the informative one.

### Per-category R@5 / R@10

| category (n) | geodesic | cosine-manifold | cosine-base | bm25 |
|---|---|---|---|---|
| 1 multi-hop (282) | 5.7% / 9.2% | 9.2% / 15.2% | 7.8% / 16.3% | 20.9% / 29.1% |
| 2 temporal (320) | 10.3% / 16.2% | 15.0% / 22.5% | 20.0% / 24.7% | 38.4% / 51.2% |
| 3 open-domain (92) | 4.3% / 7.6% | 5.4% / 12.0% | 5.4% / 9.8% | 22.8% / 25.0% |
| 4 single-hop (841) | 8.9% / 15.7% | 20.3% / 26.9% | 20.8% / 27.7% | 42.6% / 49.8% |

Geodesic trails both cosine variants in **every** category, and BM25
in every category. Its best relative showing is temporal (R@10 16.2%
vs cosine-manifold 22.5%); its worst is single-hop, the category
where lexical matching helps most.

### Rent-gate check

The Law I admission gate refused **4 of 5,882 turns** (0.07%).
**0 questions** had no admitted gold turn, so recall on the
"retrievable" subset is identical to overall recall (retrievable-only
n = 1,535). The rent gate is not the cause of these numbers.

### Sanity check (hand-verified, 3 examples from conv-26)

- Q: "When did Caroline go to the LGBTQ support group?" — gold
  `D1:3` ("I went to a LGBTQ support group yesterday and it was so
  powerful.") — geodesic ranked it **#1**; cosine-base #3; BM25 #2.
  Gold mapping correct.
- Q: "When did Melanie paint a sunrise?" — gold `D1:12` ("You'd be a
  great counselor! … By the way, take a look at this.") — the gold
  turn's text does **not** contain the sunrise information; the
  evidence is an attached image ("take a look at this"). No
  text-retrieval method can rank this turn on content. All four
  methods missed the top-10. This is a real dataset property, not a
  harness bug.
- Q: "What fields would Caroline be likely to pursue in her
  educaton?" — gold `D1:9` + `D1:11` ("continue my edu…", "keen on
  counseling or working in mental health") — mapping correct; all
  four methods missed the top-10 entirely (rank 11 for each in the
  recorded results).

Quantified: **87 of 1,535 questions (5.7%)** have *no* gold turn
sharing any content token with the question+answer — the
multimodal/uninformative-gold ceiling for text retrieval. That caps
recall for every method, but it does not explain geodesic trailing
cosine: the gap is a ranking difference on the other 94.3%.

## LongMemEval

**Dataset:** `longmemeval_s.json` from HF `xiaowu0162/longmemeval`
(MIT; Wu et al. 2024, arXiv:2410.10813). Note: this split is
**deprecated** upstream in favour of `longmemeval-cleaned` — the
`s` split is used here because it is the full-history version the
downloadable files provide; the cleaned variant's files are the
same structure at larger sizes. **500 QA items**, each with
~50 haystack sessions (**246,930 turns** total, mean 493.9/item),
of which mean **1.9 sessions (~21.9 turns)** are the answer
sessions.

**Gold (session-level):** a retrieved turn is gold iff its session
is in the item's `answer_session_ids`. This is the session-level
retrieval granularity the LongMemEval paper itself uses. Turn-level
gold is not annotated, and inventing it (e.g. by answer-string
matching) would bias the benchmark toward lexical methods — so
session-level recall is the honest metric here. It is *easier* than
LoCoMo's turn-level recall (gold density ~4.4% of the corpus vs
~0.2%), which is why absolute numbers are higher; the *ordering*
across methods is the comparable thing.

**Runtime:** 1,140.6 s (~19 min), including one interrupted first
attempt (runtime restart at 50/500 items) resumed from the
50-item checkpoint via `--resume`. First attempt also exposed a
real harness bug: 12 turns have empty content, and
`KnowledgeBase.addDocument()` throws on empty content — fixed by
skipping empty turns in the KB (the GyroMem index already refuses
them, so the corpora stay aligned). Total empty turns skipped: 12.

### Session-level recall@k and MRR@10 (n = 500)

| method | R@1 | R@3 | R@5 | R@10 | MRR@10 |
|---|---|---|---|---|---|
| **geodesic** | 8.0% | 27.8% | 46.2% | 68.2% | 0.235 |
| cosine-manifold | 36.0% | 53.4% | 60.8% | 72.0% | 0.469 |
| cosine-base | 41.4% | 60.0% | 68.8% | 80.0% | 0.528 |
| bm25 | 48.0% | 67.0% | 75.4% | 86.0% | 0.599 |

### Paired first-gold-rank (geodesic vs …)

| comparison | win | loss | tie | (hits-only subset) |
|---|---|---|---|---|
| geo vs cosine-manifold | 107 | 270 | 123 | n=417: win 107, loss 270, tie 40 |
| geo vs cosine-base | 69 | 318 | 113 | n=428: win 69, loss 318, tie 41 |
| geo vs bm25 | 86 | 351 | 63 | n=469: win 86, loss 351, tie 32 |

### Per-type R@5 / R@10

| type (n) | geodesic | cosine-manifold | cosine-base | bm25 |
|---|---|---|---|---|
| knowledge-update (78) | 61.5% / 79.5% | 84.6% / 87.2% | 92.3% / 94.9% | 85.9% / 93.6% |
| multi-session (133) | 42.9% / 69.2% | 60.2% / 75.9% | 69.9% / 83.5% | 77.4% / 90.2% |
| single-session-assistant (56) | 57.1% / 76.8% | 50.0% / 53.6% | 62.5% / 73.2% | 67.9% / 78.6% |
| single-session-preference (30) | 20.0% / 43.3% | 20.0% / 33.3% | 33.3% / 53.3% | 43.3% / 56.7% |
| single-session-user (70) | 27.1% / 52.9% | 65.7% / 77.1% | 68.6% / 77.1% | 65.7% / 80.0% |
| temporal-reasoning (133) | 51.9% / 70.7% | 58.6% / 72.9% | 64.7% / 78.2% | 82.7% / 90.2% |

Geodesic loses to cosine-base in **all six** types and to BM25 in
all six. Against cosine-manifold it wins two small-n subtypes
(single-session-assistant, n=56: R@10 76.8% vs 53.6%;
single-session-preference, n=30: R@10 43.3% vs 33.3%) and loses the
other four. Those two exceptions are real but narrow (one metric,
small n, vs one of two cosine variants) — they do not overturn the
overall loss (R@10 68.2% vs 72.0%; paired 107–270 on hits).

Two more observations:

- **Geodesic ranks gold in the top-10 fairly often but rarely
  first.** Its R@1 (8.0%) is far behind cosine-manifold (36.0%)
  and BM25 (48.0%), while its R@10 (68.2%) nearly catches
  cosine-manifold (72.0%). The geodesic ranking is "close but not
  precise": it gets the right neighbourhood (an answer session's
  turns cluster together geometrically) but not the top rank.
- **Rent-gate check:** 904 of 246,930 turns refused (0.37% — mostly
  near-duplicate generic assistant turns). **0 items** had no
  admitted gold turn, so the gate does not explain the numbers.

## Reading the numbers honestly

**Why S1's win doesn't transfer.** S1's calibrated win came from
*varying* abstraction radii across records (identity 0.15, episodic
0.7, verbatim 0.85) — the radial channel carried the signal. In
these benchmarks every record is indexed `episodic` (radius 0.7)
and every query `query` (radius 0.5), so the radial channel carries
**zero** information; the only thing distinguishing records is
direction, and the manifold projection (exponential map to radius
0.7, spherical normalization, Euclidean slice) can only distort the
hashed-TF directions, not inform the ranking. The H1 claim —
geodesic geometry improves retrieval — is **untested at real scale
with a real encoder**, not disproved. A fair test needs a real
embedding model and (per the theory) a corpus where abstraction
level actually varies across records.

**Why BM25 wins.** Benchmark questions share keywords with their
gold turns (names, places, distinctive nouns). BM25 is a lexical
method on a lexical task; with a hashed-TF encoder, the embedding
methods have little semantic signal to work with, and collisions in
the 384-bucket hash add noise. This is expected, and it is the reason
the headline comparison is geodesic-vs-cosine (same embeddings),
not geodesic-vs-BM25.

**What would change the numbers.** A real encoder (nomic-embed-text
or better) is the single biggest lever — absolute recall for all
three embedding methods should rise substantially, and the ordering
between geodesic and cosine could change. That run has not been done:
no Ollama/model is installed on this machine. Varying abstraction
radii per record (rather than uniform `episodic`) is the second
lever — it is what S1 actually tested.

## Caveats (do not quote without these)

1. **Offline encoder only.** `OfflineEncoder` is a deterministic
   hashed-TF fallback, explicitly not a learned model. Do not present
   these recall numbers as the system's quality with real embeddings.
2. **Retrieval only.** No LLM generation, no answer judging, no
   official LoCoMo/LongMemEval QA accuracy (F1). Recall@k is not a
   benchmark score for the product.
3. **Uniform abstraction.** All records `episodic`, all queries
   `query` — the radial channel is constant, so this run cannot test
   the part of GyroMem that S1 showed helping.
4. **LoCoMo gold is partly multimodal.** ~5.7% of questions have a
   gold turn that shares no content token with the question+answer
   (image-referencing turns); text retrieval cannot rank those.
5. **LongMemEval gold is session-level.** A turn counts as gold if
   its session is an evidence session — the granularity the dataset
   annotates. Turn-level precision within a session is not measured.
6. **Single run, no replicates.** One deterministic run per dataset
   (the encoder is deterministic, so re-runs reproduce exactly).
   No confidence intervals; with n = 1,535 the LoCoMo R@10 gap
   (geodesic 14.1% vs cosine-manifold 22.9%) is far beyond sampling
   noise for a paired comparison, but treat the exact percentages
   as one measurement, not an estimate with error bars.
7. LoCoMo is CC BY-NC 4.0 (academic use). LongMemEval data is MIT;
   the HF `longmemeval` split used here is deprecated in favour of
   `longmemeval-cleaned`.

## Reproduce

```bash
cd webgui
node server/bench/locomo.js        # ~1 min, writes ~/workspace/bench-data/locomo-results.json
node server/bench/longmemeval.js  # ~19 min, writes ~/workspace/bench-data/longmemeval-results.json
```

See `server/bench/README.md` for dataset download links, the
`--probe` worked-examples mode, and the `--resume` flag (the
LongMemEval run checkpoints every 50 items after an interrupted
first attempt).
