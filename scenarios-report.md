# Aegis Memory — Theory Scenarios

Generated 2026-11-11T23:34:00.497Z · encoder: offline/offline-hashed-tf (deterministic; re-run with nomic-embed-text for learned embeddings) · 52ms

**Result: 5/5 scenarios passed.**

| Scenario | Result |
|---|---|
| Geodesic retrieval beats cosine | ✅ PASS |
| Reconsolidation: success sharpens memory | ✅ PASS |
| Relaxation is reversible forgetting | ✅ PASS |
| Authority non-creation stops a laundering attack | ✅ PASS |
| Deletion is measured, not asserted | ✅ PASS |

## ✅ Geodesic retrieval beats cosine

_GyroMem H1: geodesic distance on the product manifold ranks the right-abstraction memory first where cosine is misled by lexical overlap._

- [x] **Control: cosine prefers the verbatim distractor** — cos(query, distractor)=0.555 > cos(query, target)=0.447 — lexical similarity is misled
- [x] **Geodesic prefers the episodic target** — d_M(query, target)=2.367 < d_M(query, distractor)=2.659 — radial position corrects the ranking
- [x] **End-to-end retrieval ranks the target above the distractor** — retrieved order: [identity, preference, target] — the lexical trap (distractor) falls behind the target
- [x] **Target is in the retrieved top 3** — target at rank 3 of 3
- [x] **Abstraction radii are what differ** — target radius=0.70 (episodic), distractor radius=0.85 (verbatim)

## ✅ Reconsolidation: success sharpens memory

_Law III: λ ← clip(λ + η(1 − 2·surprise)), η=0.1; transport contracts the point toward the query._

- [x] **Three successes raise λ by 3η** — λ 0.50 → 0.80 (η=0.1, surprise=0)
- [x] **Geodesic transport shortens distance to the query** — d_M 2.259 → 1.871 after two transport steps
- [x] **Two failures lower λ again** — λ 0.80 → 0.60 (surprise=1)
- [x] **Provenance invariant: origin unchanged, updates logged** — origin=user, 8 logged update events

## ✅ Relaxation is reversible forgetting

_Law IV: a_t = a_0·exp(−t/τ_relax); below the floor the record is withheld, never deleted; re-evidence restores it._

- [x] **Decay drops availability below the retrieval floor** — availability 0.0067 < floor 0.05 after 20 evidence-events (λ=0.1, τ=4)
- [x] **Decayed record is withheld from retrieval** — query returned no decayed record
- [x] **Content is retained, not deleted** — record and content still in the store
- [x] **Re-evidence restores availability and recall** — availability 1 after re-evidence; record returned again
- [x] **Deletion is different: content is gone** — deleteRecord removed content; relaxation never does

## ✅ Authority non-creation stops a laundering attack

_Law V: Auth(m′) ≤ min Auth(mᵢ). A derived record claiming user authority from an untrusted source is a cap violation, caught at read time._

- [x] **Challenge quarantines the laundered record** — verdict=quarantine (authority inflation: stored pair exceeds least-trusted source)
- [x] **Act gate refuses the laundered record** — allowed=false (record is quarantined)
- [x] **Poison never reaches retrieval** — derived record absent from retrieved hits
- [x] **Legitimate records still work (no blanket block)** — user refund-policy record still retrieved
- [x] **Untrusted source cannot authorize action** — untrusted_external record: act denied

## ✅ Deletion is measured, not asserted

_P4/P5: support-closure removal + fixed-reader residual probe + self-issued certificate stating a measured rate and scope._

- [x] **Support closure removes the dependent record** — deleted 2 records (source + dependent)
- [x] **Certificate reports a measured rate, not a boolean** — probeRate=0, scope=text-store-only, auditDraws=5
- [x] **Certificate is honestly self-issued and unsigned** — no attestation claimed
- [x] **Independent re-probe reproduces the reported rate** — re-probed rate 0 == certificate rate 0
- [x] **Content is actually gone** — both records have empty content and deleted status

## Limits (read before citing)

- These scenarios run on the **offline hashed-TF encoder** (deterministic, no network). They demonstrate that the *mechanisms* behave as the theory says; they are not the papers’ Phase 2 evaluations (LoCoMo/LongMemEval, ≥3 replicates, frozen harnesses, learned embeddings).
- S1’s corpus is calibrated so the lexical control holds; it shows geometry *can* correct a ranking cosine gets wrong, not that it always does. The Phase 2 geometry control experiment is the real test.
- S4 simulates the laundering step by writing an inflated pair with honest provenance; it tests the read-time defense, not the consolidator.
- Deletion scope is the text store only, point-in-time, exactly as the certificate states.
