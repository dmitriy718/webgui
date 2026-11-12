# Show HN draft — post Thursday morning ET (8–10am is the best window)

**Title (≤80 chars):**
`Show HN: Aegis Memory – agent memory that decides what to trust`

**Body:**

I built a local LLM chat app (WebGUI — zero deps, Ollama/LM Studio) whose
memory layer is the interesting part: **Aegis Memory**.

Most agent memory remembers everything. Aegis decides what gets
remembered, and whether to trust it:

- Memories live on a mixed-curvature manifold (hyperbolic × spherical ×
  Euclidean). Retrieval is geodesic distance, not cosine. Radial position
  encodes abstraction.
- Every record carries an authority pair (origin, act class). A derived
  record can never exceed its least-trusted source — authority
  non-creation — enforced by an act gate and a read-time immune system
  (pass / undetermined / quarantine).
- Forgetting is reversible drift (availability decay, restored on
  re-evidence). Deletion is a separate, measured operation: support
  closure + a residual-recovery probe + a certificate that states a
  measured rate and its scope, self-issued and unsigned.

The demo that convinced me it matters: I planted a fake "refund of $500
approved" in the store, then had a consolidator derive a "user approved
the refund" record from it. The read-time challenge quarantined it, the
act gate refused it, and the poison never reached the model — while the
legitimate refund policy stayed retrievable. It's scenario 4 of 5 in the
repo; all five run with `npm run scenarios` and print a report with the
numbers.

60 seconds to try it:

```
git clone https://github.com/dmitriy718/webgui.git
cd webgui && npm start
# optional, for real embeddings: ollama pull nomic-embed-text
```

Repo: https://github.com/dmitriy718/webgui

Honest status: this is a theory with a working reference implementation,
not a benchmarked product. The two papers are in `docs/papers/`; they
state five predictions with kill criteria and make no empirical claims.
The scenarios demonstrate the mechanisms — they are not the Phase 2
evaluations (LoCoMo/LongMemEval). Happy to be told where the geometry or
the authority lattice is wrong.

**Posting notes (do not paste):**
- Post from Dmitriy's HN account, Thursday morning ET. Answer comments
  for the first 2–3 hours — early replies are most of the ranking.
- If it stalls on the new page, do not repost the same day.
- The repo URL above assumes the repo name `webgui` under
  `dmitriy718` (confirmed Nov 11, 2026).
