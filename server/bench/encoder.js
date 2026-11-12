'use strict';

/**
 * encoder.js — shared benchmark encoder resolution.
 *
 * BENCH_ENCODER=offline (default) | ollama
 * BENCH_OLLAMA_URL      Ollama base URL for ollama mode (default http://localhost:11434)
 * BENCH_EMBEDDING_MODEL embedding model for ollama mode (default nomic-embed-text)
 *
 * ollama mode is STRICT: the encoder is probed with one tiny embedding
 * request, and if the probe fails it THROWS instead of silently falling
 * back to the offline encoder. A silent fallback would re-run the
 * offline numbers while claiming real-encoder ones — the one failure
 * this file exists to prevent.
 *
 * The resolved encoder object is shared across the run's per-conversation
 * / per-item GyroMemStore instances (encoders are stateless: embedOne is
 * just a call into the base model). Offline mode returns encoder: null,
 * which means "leave each store's default OfflineEncoder in place".
 */

const { OfflineEncoder, OllamaEncoder } = require('../gyromem');

async function resolveBenchEncoder() {
  const kind = String(process.env.BENCH_ENCODER || 'offline').toLowerCase();
  if (kind === 'offline') {
    return {
      kind: 'offline',
      model: 'offline-hashed-tf',
      encoder: null,
      label:
        'OfflineEncoder (deterministic hashed TF, gyromem.js) — NOT a learned model',
    };
  }
  if (kind === 'ollama') {
    const baseUrl = process.env.BENCH_OLLAMA_URL || 'http://localhost:11434';
    const model = process.env.BENCH_EMBEDDING_MODEL || 'nomic-embed-text';
    // Keep a reference so the class isn't tree-shaken out of the
    // require graph in environments that prune unused imports.
    void OfflineEncoder;
    const encoder = new OllamaEncoder({ baseUrl, model });
    try {
      await encoder.embedOne('gyro-mem encoder probe');
    } catch (e) {
      throw new Error(
        `BENCH_ENCODER=ollama requested but the probe failed: ${e.message} ` +
          `(baseUrl=${baseUrl}, model=${model}). Refusing to run silently on the offline encoder.`
      );
    }
    return {
      kind: 'ollama',
      model,
      encoder,
      label: `OllamaEncoder (ollama, model=${model}, baseUrl=${baseUrl})`,
    };
  }
  throw new Error(`Unknown BENCH_ENCODER "${process.env.BENCH_ENCODER}" (want offline|ollama)`);
}

module.exports = { resolveBenchEncoder };
