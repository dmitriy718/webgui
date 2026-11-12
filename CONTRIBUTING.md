# Contributing to WebGUI + Aegis Memory

## What helps most

1. **Bug reports with a reproduction** — steps, expected vs actual, logs.
   The server logs to the `logs` collection and the console; include the
   relevant lines.
2. **Scenario improvements** — the five scenarios in `server/scenarios.js`
   are the project's evidence. A scenario that falsifies a claim is more
   valuable than one that confirms it: open an issue with the numbers.
3. **Theory discussion** — cite the papers' §5 predictions and say which
   one is at stake. Do not present a demo result as a Phase 2 result.

## Ground rules

- **Zero dependencies.** The server and the frontend use only Node
  built-ins and vanilla JS. Do not add a dependency without a discussion
  first.
- **No silent behaviour changes.** If a change alters retrieval ranking,
  admission, or any law's behaviour, add or update a test in
  `server/gyromem.test.js` and note it in the PR.
- **Honesty about authority.** Never add a path that lets record text
  raise its own authority, and never log or return raw credentials or
  API keys. The API returns `hasApiKey`, never the key.
- **Tests before polish.** `npm test` (24 tests) and `npm run scenarios`
  (5/5) must stay green. A PR that breaks either needs the failing check
  fixed or honestly re-scoped in the same PR — not silently weakened.

## Running the app

```bash
npm start          # http://127.0.0.1:3000
npm test           # unit tests
npm run scenarios  # theory scenarios (prints a Markdown report)
npm run demo       # end-to-end memory walkthrough
```

## Release checklist (for maintainers)

1. `npm test` green, `npm run scenarios` 5/5.
2. Regenerate `scenarios-report.md` (`node server/scenarios.js > scenarios-report.md`).
3. Boot the server from a clean `data/` directory and smoke-test:
   health, login, providers, chat (needs a local model), knowledge
   upload + search, memory stats/records, scenarios endpoint.
4. Bump `version` in `package.json` and `VERSION` in `server/index.js`
   together.
5. Update the README's scenario table if any scenario changed.
