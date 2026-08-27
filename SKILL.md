---
name: pr-triage
description: Use when asked to triage PRs, "what PRs need my attention", "any new PRs?", or invokes /pr-triage. Surfaces only NEW actions (review, re-review, respond, fix CI, architecture-check drafts) across the SafeInsights repos plus any repo where a review was requested from you, remembering what was already shown. Running it marks surfaced PRs as seen. Also covers team PR stats ("dev velocity", "response times", "how fast do I review") and plotting those stats over time ("plot AI usage", "graph velocity").
---

# PR Triage

## Workflow

1. Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage triage`
   - The default run marks everything it prints as seen. If the user only wants a
     peek without marking seen, pass `--dry-run`. `--json` gives structured output
     if you need to reason over items programmatically.
2. Relay the report **verbatim** — do not summarize, reorder, or reformat it.
3. If there are actions, ask which one(s) to take now. Do not start any action
   unprompted.
4. Chain into the picked actions:
   - **Review** / **Re-review** → invoke the draft-pr-review skill for that PR
     number (run it from the PR's repo directory under `~/code/si/`, or pass
     `--repo`-aware commands as that skill describes).
   - **Finish & submit your pending review** → a PENDING review already
     exists; per draft-pr-review's notes, append to it via GraphQL
     `addPullRequestReviewThread` or remind him to open the review URL and submit.
   - **Architecture check** → fetch the diff (`gh pr diff <n> --repo <repo>`) and
     give a broad structural overview: what the change does, design concerns,
     simplification opportunities. No GitHub writes.
   - **Respond** / **Fix CI** / **Approved — merge?** → these are the owner's own PRs;
     help investigate as asked (e.g. `gh pr checks`, reading new comments).
5. **Always close with a recap**, after the picked actions are done — especially
   after drafting reviews, whose per-PR write-ups are long enough that the first
   ones scroll out of view. The recap is the last thing in the response, below any
   detail, and covers **every** PR that was acted on, not just the last one. One
   line each:
   - PR ref + one-clause outcome (`draft posted, 6 comments` / `reviewed, no draft
     — nothing worth flagging` / `investigated, CI red on X`).
   - The draft URL, if one was created. Never make him scroll up to find a link.
   - What he has to do next, if anything — submit a draft, rerun a suite, reply to
     someone. Say "nothing needed" outright when that's the answer.

   Keep it scannable: no re-argued findings, no repeated praise. If a PR was
   surfaced but deliberately not acted on, list it too with the reason, so the
   recap accounts for the full triage list.

## Stats

When asked for team PR stats (dev velocity, how fast devs respond to review
feedback, his own review latency):

1. Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage stats`
   - `--days N` changes the window (default 30). `--json` for structured output.
2. Relay the report verbatim. Metrics are medians; `n=` is the sample count. The AI-usage line is a labeled heuristic (verbosity + explicit AI markers, 0-100 per time bucket); present it with that caveat — it is a proxy, not proof.
3. The first run fetches ~30 days of history and is slow; later runs update
   incrementally from `stats-history.json` and are fast.

## Plotting stats

When asked to plot, chart, graph, or visualize the stats ("plot AI usage over
time", "graph team velocity"):

1. Load the `dataviz` skill FIRST — before writing any chart code, choosing colors,
   or laying anything out. Non-negotiable prerequisite.
2. Get structured data: `pnpm --dir ~/code/si/.claude/skills/pr-triage stats --json`
   (add `--days N` for longer trends — buckets are weekly at ≤90 days, monthly
   above; wider windows backfill automatically). In the JSON: `aiUsage` is per-dev
   `{ buckets: [{bucketStart, score, prCount, commentCount}], markerRate, prCount }`;
   `responses` and `velocities` map dev → duration samples in hours;
   `myLatencies` is an array of hours.
3. Build the visualization per dataviz guidance as a self-contained HTML file
   (per-dev line charts over `bucketStart` suit the AI-usage trend; distributions
   or medians-over-time suit velocity/latency). open it as a rendered
   file. Keep the AI-usage heuristic caveat visible on the chart.

## Notes

- Config (repo list): `config.json` next to this file. Those repos are watched
  wholesale — every open PR in them is tracked.
- **Review requests outside those repos are found automatically.** Each run also
  searches `review-requested:@me` across all of GitHub, so a PR in a repo the config
  never lists still surfaces. Only the PR that actually requests you is reported from
  such a repo, not everything else open there. Requests whose PR has not been updated
  in 180 days are skipped, which keeps long-abandoned ones from resurfacing. If a repo
  starts showing up often, add it to `config.json` to get full tracking of it.
- Triage memory: `state.json` next to this file — one snapshot per open PR.
  Deleting it resets memory (everything surfaces again). To "unsee" a single PR,
  delete just that PR's key.
- Stats cache: `stats-history.json` next to this file — deleting it forces a full
  history refetch on the next stats run; nothing else is lost.
- Neither script ever writes to GitHub.
