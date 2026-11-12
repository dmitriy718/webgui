# WebGUI HTTP API

Base URL: the server root (default `http://127.0.0.1:3000`).
All responses are JSON unless noted. Errors are `{ "error": "message" }`
with the HTTP status. Auth: when `WEBGUI_PASSWORD` is set, every
`/api/*` route except `/api/health`, `/api/auth/login` and
`/api/auth/status` requires the session cookie or
`Authorization: Bearer <token>`. Static files are public; the SPA shows a
login screen when the status endpoint reports `authenticated: false`.

Rate limits: 600 req/min per client on `/api/*`, 120 req/min on
`/api/chat`. JSON bodies max 4 MB; multipart uploads max 8 MB.

## Health & auth

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok, version, uptimeSec, authEnabled, memory: { encoder, records, live } }` |
| POST | `/api/auth/login` | `{ "password": "…" }` | `{ ok: true }` + `Set-Cookie: webgui_session=…; HttpOnly` |
| POST | `/api/auth/logout` | — | `{ ok: true }` + cleared cookie |
| GET | `/api/auth/status` | — | `{ enabled: bool, authenticated: bool }` |

## Providers (LLM backends)

Provider object: `{ _id, name, kind: "ollama"\|"openai", baseUrl, hasApiKey: bool, enabled }`
(`apiKey` is write-only: accepted on create/update, never returned.)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/providers` | list |
| POST | `/api/providers` | `{ name, kind, baseUrl, apiKey?, enabled? }` → created provider |
| PUT | `/api/providers/:id` | partial update; returns updated provider |
| DELETE | `/api/providers/:id` | → `{ ok: true }` |
| GET | `/api/providers/:id/models` | `[{ id, name, family?, size? }]` (Ollama native `/api/tags` first) |
| GET | `/api/providers/:id/ping` | `{ ok, latencyMs, error?, version? }` |

## Conversations

Conversation list item: `{ _id, title, pinned, createdAt, updatedAt, providerId, model, messageCount }`.
Full conversation: the same plus `messages: [{ role, content, reasoning?, toolCalls? }]`,
`settings`, `systemPrompt`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/conversations` | list, newest first |
| POST | `/api/conversations` | `{ title?, providerId?, model? }` → created conversation |
| GET | `/api/conversations/:id` | full conversation (404 if missing) |
| PUT | `/api/conversations/:id` | `{ title?, pinned? }` |
| DELETE | `/api/conversations/:id` | → `{ ok: true }` |

## Chat

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/chat` | `{ conversationId?, provider, model, messages: [{role, content}], settings?, systemPrompt?, toolsMode?, knowledgeIds?: string[], stream?: bool }` | `stream: true` (default) → SSE events (`delta`, `reasoning`, `tool_call`, `tool_result`, `notice`, `done`, `error`, `aborted`); `stream: false` → `{ id, title, content, reasoning, toolCalls, usage, finishReason, iterations, textFallback }` |

Notes: `messages` are the client-side history; the server appends the
assistant turn and persists the conversation (creating it when
`conversationId` is absent). `knowledgeIds` selects knowledge-base
documents to retrieve from; retrieval is hybrid BM25 + GyroMem geodesic
(see Memory) and retrieved passages carry authority headers.

## Templates

Template: `{ _id, name, description, content }` (`{{placeholder}}` in content).

| Method | Path |
|---|---|
| GET | `/api/templates` |
| POST | `/api/templates` `{ name, description?, content }` |
| PUT | `/api/templates/:id` |
| DELETE | `/api/templates/:id` |

## Settings

Global settings document: `{ _id: "global", theme, defaultProviderId,
defaultModel, defaultSettings: { temperature, topP, maxTokens,
frequencyPenalty, presencePenalty }, toolsMode, memory: { enabled,
providerId, embeddingModel } }`.

| Method | Path |
|---|---|
| GET | `/api/settings` |
| PUT | `/api/settings` (partial merge; `memory` is merged as a sub-object) |

## Knowledge base

Document list item: `{ id, title, source, charCount, chunkCount, created }`.
Upload (JSON): `{ title, content, source? }`. Upload (multipart):
field `file` (text file) + optional fields `title`, `source`.
Uploads are indexed into GyroMem memory automatically (origin `user`).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/knowledge` | list |
| POST | `/api/knowledge` | JSON or multipart → created document `{ id, title, source, charCount, chunkCount, created, indexed }` |
| GET | `/api/knowledge/:id` | `{ id, title, source, content, charCount, chunkCount, created }` |
| DELETE | `/api/knowledge/:id` | deletes the document and its memory records |
| GET | `/api/knowledge/search?q=…&k=4` | hybrid search → `[{ docId, docTitle, source, chunk, chunkIndex, score, retrieval, authority?, lambda?, availability?, origin? }]` |

## Tools & MCP

| Method | Path | Response |
|---|---|---|
| GET | `/api/tools` | `[{ id, builtin, mcp?, name, description }]` (available tools) |
| GET | `/api/mcp` | `[{ id, state, tools: [names] }]` |
| POST | `/api/mcp` | `{ id, transport: "stdio"\|"http", command?, args?: [], env?: {}, url? }` → `{ id, state }` |
| DELETE | `/api/mcp/:id` | disconnect + unregister |
| GET | `/api/mcp/log` | `[{ ts, line }]` (last 300, newest last) |

Note: MCP registration failures are logged, not fatal; the server entry
shows `state: "error"` with the log line explaining why.

## Logs

| Method | Path | Response |
|---|---|---|
| GET | `/api/logs?limit=100` | `[{ ts, level, source, message, providerId?, model? }]` newest first |

## Memory (Aegis / GyroMem)

Memory record (list view): `{ id, docId, chunkIndex, content (truncated
to 500 chars), origin, actClass, owner, scope, lambda, availability,
usage, status: "live"\|"quarantined"\|"deleted", flagged, created,
updated }`. Full view adds `point` (manifold coordinates), `support`,
`provenance`, `challenges`, `rentCharged`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/memory/stats` | `{ encoder: { kind, model }, records, live, quarantined, flagged, deleted, ledgerEntries }` |
| GET | `/api/memory/records?status=live&limit=100` | list, newest first |
| GET | `/api/memory/records/:id` | full record |
| POST | `/api/memory/records/:id/challenge` | run the read-time challenge → `{ verdict, reason, lambda? }` |
| POST | `/api/memory/records/:id/restore` | `{ confirmed: true }` required → `{ restored, reason? }` |
| POST | `/api/memory/records/:id/outcome` | `{ surprise: 0..1, updater? }` → updated record (Law III) |
| POST | `/api/memory/records/:id/act-gate` | `{ actClass: "inform"\|"act", channelAuthorized? }` → `{ allowed, reason?, pair? }` |
| DELETE | `/api/memory/records/:id` | support-closure deletion → `{ deletedIds, certificate }` |
| POST | `/api/memory/dream` | offline consolidation → `{ clusters, merged, promoted }` |
| POST | `/api/memory/relax` | `{ events?: number }` → `{ changed: [ids] }` |
| GET | `/api/memory/ledger?limit=100` | hash-chained audit entries, newest first |
| POST | `/api/memory/scenarios` | run the five theory scenarios → `{ scenarios: [{ id, title, passed, checks: [{ name, passed, detail }] }], passed, failed }` |

## Static files

- `GET /` → `public/index.html`
- `GET /css/app.css`, `GET /js/app.js` (and any file under `public/`)
- Unknown paths → `404 { "error": "not found" }`; `/api/*` unknowns → same JSON 404.
- Security headers on every response: `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
