# r/LocalLLaMA draft — post the day AFTER the Show HN post

**Title:**
`WebGUI: a local chat UI whose memory decides what to trust — geodesic retrieval + an immune system for poisoned memories (Ollama/LM Studio, zero deps)`

**Body:**

I built WebGUI, a local-first chat UI for your own models (Ollama, LM
Studio, OpenAI-compatible, no cloud, no build step, `npm start` and it
runs). The part I actually want feedback on is the memory layer, Aegis.

Instead of cosine on flat embeddings, memories live on a mixed-curvature
manifold and retrieval is geodesic distance. Every record carries an
authority pair, and a derived record can never claim more authority than
its least-trusted source — so a poisoned or laundered memory gets
quarantined at read time instead of being acted on. Forgetting is
reversible (availability decay); deletion is measured, with a
residual-recovery rate in the certificate.

It runs fine on the offline fallback encoder, but with
`ollama pull nomic-embed-text` it uses real embeddings. Five scenarios
ship in the repo (`npm run scenarios`) — including planting a fake refund
approval in memory and watching the agent refuse to act on it.

GitHub: https://github.com/dmitriy718/webgui

Honest caveat: this is a theory with a working reference implementation,
not a benchmarked product. The papers are in `docs/papers/`. I did run
LoCoMo/LongMemEval retrieval overnight with the offline encoder, and
geodesic does NOT beat cosine there (LoCoMo recall@10 14.1% vs 22.9%;
full report in `bench-report.md`, harness in `server/bench/`). The
honest reading is that the geometry claim is untested with a real
encoder, not disproved — re-running with nomic-embed-text is next.

**Posting notes (do not paste):**
- One post, link in the body, no cross-post spam the same day. Reply to
  comments; the local-LLM crowd will test the quickstart and tell you
  fast if it breaks.
- Fix the repo URL if the real repo name differs.
