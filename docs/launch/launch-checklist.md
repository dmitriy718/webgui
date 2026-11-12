# Launch checklist — first step to going viral

Goal: one public repo + one high-signal launch post, then let the demo do
the work. Virality here comes from a 60-second path (clone → running
app → a memory refusing a planted instruction), not from posting volume.

## Sequence (do not skip steps)

1. **Publish the repo (Dmitriy, ~10 min)**
   - Unzip the package, `cd webgui`, and run:
     ```bash
     git init -b main
     git add -A
     git commit -m "WebGUI 1.1.0: complete app + Aegis Memory"
     gh auth login            # once, in the browser — connects his GitHub account
     gh repo create webgui --public --source=. --push
     ```
   - Verify the README renders and the screenshots show on github.com.
   - (The commit already exists in Ember's copy at `~/workspace/webgui`,
     but that copy can't be pushed from his machine — the zip is the
     hand-off; the commands above recreate it in one minute.)
2. **Clean-clone check (Ember, done before publishing)**
   - Fresh unzip → `npm start` → health 200 → `npm run scenarios` 5/5.
   - The quickstart in the README must work exactly as written.
3. **Show HN (Dmitriy, Thursday morning ET 8–10am)**
   - Draft: `docs/launch/show-hn.md`. Post from his HN account.
   - Answer comments for 2–3 hours; early replies are most of the ranking.
   - If it stalls, do not repost the same day.
4. **r/LocalLLaMA (Dmitriy, next day)**
   - Draft: `docs/launch/local-llama.md`. One post, link in body.
5. **X thread (Dmitriy, same day as HN or next)**
   - Draft: `docs/launch/x-thread.md` + memory-console screenshot.

## Step 0 — local git repo (done by Ember, recreated from the zip above)

The zip is the hand-off; the commands in step 1 recreate the repo on his
machine. (Ember's own copy at `~/workspace/webgui` is already a git repo
with the same first commit, for reference.)

## Rules

- **One launch post per day, max.** No same-day cross-post spam (the
  Reddit bot-reply wave in October was invisible for exactly this reason).
- **Never overclaim.** The README and every draft state the honest
  status (theory + reference implementation, scenarios ≠ Phase 2 evals).
  If a commenter falsifies a claim, that's a win — answer it, don't
  argue it.
- **The demo is the marketing.** If someone can't get from clone to a
  running app in 60 seconds, fix the quickstart before posting more.
- **arXiv is a separate track.** The papers ship in `docs/papers/` as
  preprints; arXiv submission (from Dmitriy's own account) can follow
  and be announced as an update, it does not block the launch.

## What success looks like (first 48h)

- Repo stars + issues filed by strangers (issues > stars: they mean
  people actually ran it).
- One comment thread that argues about the geometry or the authority
  lattice — that argument is the viral surface.
- At least one person runs `npm run scenarios` and reports the numbers.
