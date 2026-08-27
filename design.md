# pr-triage Skill Design

2026-08-07

## Purpose

Surface the *new* PR actions Nathan should take across the SafeInsights repos he is
responsible for, without re-notifying about PRs already seen and without posting
anything to GitHub for memory to work. Triage is fully scripted; Claude spends tokens
only on presenting the report and executing the actions Nathan picks.

## Layout

```
~/code/si/.claude/skills/pr-triage/
  SKILL.md              # thin workflow: run script, relay report, act on picks
  design.md             # this document
  package.json          # "type": "module", scripts triage/stats/test — zero dependencies
  pnpm-workspace.yaml   # lockfile:false + verifyDepsBeforeRun:false — keeps pnpm from creating node_modules/lockfile
  config.json           # { "repos": ["safeinsights/management-app", ...] }
  scripts/lib.ts        # pure triage logic (snapshots, diffing, actions, report)
  scripts/lib.test.ts
  scripts/triage.ts     # triage CLI: gh calls, state IO, orchestration
  scripts/stats-lib.ts  # pure stats computation
  scripts/stats-lib.test.ts
  scripts/stats.ts      # stats CLI: gh history fetch, report
  state.json            # triage memory, created/rewritten by the triage script
  stats-history.json    # stats history cache, created/updated by the stats script
```

- `config.json` is seeded from the `responsible repos` list previously in
  `~/code/si/info.yaml` (which is left untouched).
- The script runs on node's native TypeScript support (node >= 23.6; v25 installed) —
  no build step, no `pnpm install`, no `node_modules`.
- Invocation: `pnpm --dir ~/code/si/.claude/skills/pr-triage triage [--dry-run] [--json]`.

### Discovery

Sessions usually start in `~/code/si/<repo>`, so `/pr-triage` must be discoverable
from ancestor directory `~/code/si/.claude/skills`. Verify during implementation. If
ancestor discovery does not work, add a two-line shim skill at
`~/.claude/skills/pr-triage/SKILL.md` that points at this directory; all code stays
here.

## Scope

All open PRs in the configured repos, including Nathan's own. PRs merged or closed
since the last run are silently dropped from state.

## Pipeline (`triage.ts`)

1. Read `config.json` for the repo list.
2. Resolve GitHub login via `gh api user -q .login`; cache it in `state.json`.
3. Per repo:
   `gh pr list --repo <repo> --state open --json number,title,author,isDraft,headRefOid,url,createdAt,updatedAt,reviewRequests,reviewDecision,comments,reviews,statusCheckRollup`
4. Load `state.json`; compute a snapshot per PR and diff against the stored one.
5. Enrichment: for PRs whose action would be Review/Re-review, check
   `gh api repos/<o>/<r>/pulls/<n>/reviews` for a PENDING review by Nathan at the
   current head SHA; if present the action becomes "finish & submit pending review".
6. Print the report (human-readable by default, machine-readable with `--json`).
7. Rewrite `state.json` with current snapshots (skipped with `--dry-run`).

`gh` handles auth; the script shells out to it rather than talking to the API
directly.

## Memory model

"Seen when surfaced": a PR/action pair stops appearing once it has been shown, and
reappears only when the PR changes — with a description of what changed.

### Snapshot schema (`state.json`)

```json
{
  "login": "<github-login>",
  "prs": {
    "safeinsights/management-app#123": {
      "headSha": "abc123",
      "isDraft": false,
      "commentCount": 4,
      "reviewCount": 2,
      "reviewDecision": "REVIEW_REQUIRED",
      "reviewRequestedFromMe": true,
      "ciFailing": false,
      "surfacedAt": "2026-08-07T15:00:00Z"
    }
  }
}
```

A missing or unparsable `state.json` means first run: everything surfaces and the
report says so.

### Change signals (re-surface triggers)

- New commits (`headSha` changed)
- New comments or reviews (count deltas; report "N new comments/reviews")
- State transitions: draft → ready, review re-requested from Nathan,
  `reviewDecision` changes (e.g. flipped to APPROVED)
- CI newly failing — tracked **only on Nathan's own PRs** (from
  `statusCheckRollup`); others' CI is ignored as noise

The what-changed line is assembled from the field diff, e.g.
"2 new commits, 1 new comment, now ready for review".

## Action rules (report priority order)

1. Own PR, CI newly failing → **Fix CI**
2. Others' non-draft PR, new or review requested → **Review** (`/draft-pr-review N`);
   becomes **Finish & submit pending review** when enrichment finds one
3. Others' PR previously seen, new commits → **Re-review**
4. Own PR, new comments/reviews → **Respond**; `reviewDecision` newly APPROVED →
   **Approved — merge?**
5. Others' new draft PR → **Architecture check**

## Report

Prioritized list: repo, PR number, title, author, recommended action, and the
what-changed line for resurfaced PRs. When new activity lands on a PR Nathan has
already reviewed, a note line states his prior review state ("note: you approved
before this activity" / requested changes / commented) so a stale approval is
never mistaken for a fresh ask. First-run reports note that everything is new.
The script emits the final formatting; Claude relays it verbatim.

## SKILL.md workflow

1. Run the script (default mode — marks seen).
2. Show the report verbatim.
3. Ask which action(s) to take now.
4. Chain into the picked actions: `/draft-pr-review <n>` for reviews/re-reviews, an
   architecture read-through for draft PRs, open-ended help for respond/fix-CI/merge.

`--dry-run` exists for peeking without marking seen; mention it in SKILL.md.

When Nathan asks for team/PR stats ("dev velocity", "how fast are reviews
happening", "/pr-triage stats"), run the stats script instead and relay its
report verbatim.

When Nathan asks to plot/visualize stats over time, SKILL.md directs Claude to
load the `dataviz` skill first, pull structured data via `stats --json`, and
deliver a self-contained HTML chart (per-dev trend lines from `aiUsage` buckets,
duration distributions for velocity/latency).

## Stats mode

Invocation: `pnpm --dir ~/code/si/.claude/skills/pr-triage stats [--days N] [--json]`
(default window 30 days). Separate script (`stats.ts` + pure logic in
`stats-lib.ts`); triage and stats never share state.

### Metrics (aggregated across all configured repos)

1. **Dev response to review feedback** — for each COMMENTED or CHANGES_REQUESTED
   review left by someone else on a dev's PR: time until that dev's next activity
   on the PR (issue comment or pushed commit). Median per dev, with sample count.
2. **Dev velocity** — merged-PR count in the window per dev, plus median
   created→merged duration.
3. **Nathan's review latency** — for others' PRs created in the window that Nathan
   has reviewed: median time from PR creation to Nathan's first submitted review.
4. **AI-usage heuristic (per dev, time-bucketed)** — a 0-100 composite index from
   verbosity signals (PR-body length and markdown structure, commit-message
   length, comment length; log-scale saturation at 3000/12/400/800), floored at
   90 when an explicit AI marker (Co-Authored-By: Claude/Copilot/etc.,
   "Generated with ...", 🤖) appears in the PR body or a commit message. Buckets
   are 7 days (window ≤ 90 days) or 30 days; a separate per-dev "AI-marker PR %"
   is reported. Explicitly labeled a heuristic — verbosity is a proxy, not proof.
   Bot accounts (dependabot, github-actions, `app/*`, `*[bot]`) are excluded from
   this metric only.

Medians (not means) throughout — small samples, long tails.

### Incremental history cache

Requirement: full history fetch happens once; afterwards each run fetches only
what changed since the previous run.

`stats-history.json`:

```json
{
  "fetchedAt": "2026-08-07T15:00:00Z",
  "coverageStart": "2026-07-08T00:00:00Z",
  "prs": {
    "safeinsights/management-app#120": {
      "author": "alice",
      "createdAt": "...", "mergedAt": "...", "updatedAt": "...",
      "reviews": [{ "author": "nathan", "state": "COMMENTED", "submittedAt": "..." }],
      "comments": [{ "author": "alice", "createdAt": "..." }],
      "commits": [{ "committedDate": "..." }]
    }
  }
}
```

- **First run:** per repo, `gh pr list --state all --search "updated:>=<window-start-date>"`
  with the full JSON field set; store trimmed entries; set `coverageStart` to the
  window start.
- **Subsequent runs:** same query with `updated:>=<fetchedAt minus 1 day>` (overlap
  absorbs clock skew); merge fetched entries over stored ones by key.
- **Window wider than coverage** (`--days` reaching before `coverageStart`): full
  refetch from the new window start, `coverageStart` moves back.
- **Pruning:** entries whose `updatedAt` and `mergedAt` both predate `coverageStart`
  are dropped on write. Metrics always filter to the requested window at compute
  time — the cache may hold more than the window needs.
- Cache writes are atomic (temp file + rename), same as triage state.

Cache schema v2: entries carry compact text signals (`bodyChars`,
`bodyStructure`, PR/commit `hasAiMarker`, commit `messageChars`, comment
`chars`) computed at trim time — raw text is never cached. A `version` field
guards the schema: any cache without `version: 2` is discarded and fully
refetched on the next run (self-healing migration). Historical backfill needs
no separate command — widening `--days` past coverage refetches and the trend
covers the whole window.

## Error handling

- A repo whose `gh` call fails: report the failure, continue with other repos, and
  leave that repo's stored snapshots untouched (nothing falsely marked seen).
- Enrichment call failures degrade gracefully to the plain Review action.
- State writes are whole-file rewrites; the file is small enough that atomicity is a
  non-issue, but write via temp file + rename anyway.

## Non-goals

- No comments, reviews, or any other writes to GitHub from the triage script itself
  (the only GitHub writes happen later via draft-pr-review, at Nathan's request).
- No cross-machine state sync; state is per-machine.
- No scheduling/cron; the skill runs on demand.
