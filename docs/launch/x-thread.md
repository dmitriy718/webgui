# X thread draft — post after Show HN, same day or next

**1/**
Most agent memory remembers everything. I built one that decides what to
trust.

Aegis Memory: memories on a curved manifold, geodesic retrieval, and an
authority lattice that stops poisoned memories from authorizing actions.

**2/**
The demo that sold me: I planted a fake "refund of $500 approved" in the
store. A consolidator derived a "user approved it" record from it.

The read-time challenge quarantined it. The act gate refused it. The
poison never reached the model.

**3/**
How it works:

- Product manifold H×S×E; retrieval = geodesic distance
- Every record: (origin, act class). A derivation can never exceed its
  least-trusted source
- Forgetting = reversible drift, not deletion
- Deletion = measured, with a residual probe + certificate

**4/**
It's inside WebGUI, a local chat UI (Ollama / LM Studio, zero deps):

git clone https://github.com/dmitriy718/webgui.git
cd webgui && npm start

Five theory scenarios ship in the repo — `npm run scenarios` prints the
report with the numbers.

**5/**
Honest status: theory + working reference implementation, not a
benchmarked product. Papers in docs/papers/. The scenarios demonstrate
the mechanisms; the Phase 2 evals (LoCoMo/LongMemEval) are still to run.

Tell me where the geometry or the authority lattice is wrong.

**Posting notes (do not paste):**
- Attach the memory-console screenshot (docs/screenshot-memory.png).
- Fix the repo URL if the real repo name differs.
