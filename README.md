# pr-triage

A Claude Code skill that surfaces only the **new** pull-request actions across a set
of watched repos, and remembers what it already showed you.

Triage is fully scripted, so the model spends its tokens presenting the report and
doing the work you pick — not on fetching and diffing PR state. The scripts never
write to GitHub; every `gh` call is a read.

## What it reports

Each open PR is classified into one action, highest priority first:

| Action | Meaning |
| --- | --- |
| `Fix CI` | Your PR, checks are failing |
| `Review` | Awaiting your first review |
| `Finish & submit your pending review` | You have a PENDING draft at the current head |
| `Re-review` | Moved since you last reviewed it |
| `Respond` | Your PR, someone commented |
| `Approved — merge?` | Your PR, approved and ready |
| `Architecture check` | A draft worth an early structural look |
| `Updated (FYI)` | Changed, but needs nothing from you |

A PR that has not changed since the last run is not reported again.

## Install

Clone into a `skills` directory Claude Code discovers — either `~/.claude/skills/`
(global) or `<project>/.claude/skills/`:

```bash
git clone https://github.com/nathanstitt/pr-triage ~/.claude/skills/pr-triage
```

Requirements: **node ≥ 23.6** (the scripts run on native TypeScript type stripping —
no build step, no `node_modules`) and an authenticated [`gh`](https://cli.github.com)
CLI. There are zero runtime dependencies; `pnpm` is used only as a script runner.

`SKILL.md` ships with its commands pointing at the author's own install path
(`~/code/si/.claude/skills/pr-triage`). If you clone somewhere else, update the four
`pnpm --dir` paths in it to match — the scripts themselves resolve their own location,
so nothing else needs changing.

Then set your watched repos in `config.json`:

```json
{ "repos": ["owner/repo", "owner/other-repo"] }
```

Review requests from **outside** those repos are found automatically — each run also
searches `review-requested:@me` across GitHub, so a PR in an unlisted repo still
surfaces. Only the PR that actually requests you is reported from such a repo.

## Usage

Ask Claude to triage your PRs, or invoke `/pr-triage` directly. To run the scripts by
hand:

```bash
pnpm --dir ~/.claude/skills/pr-triage triage            # report, and mark seen
pnpm --dir ~/.claude/skills/pr-triage triage --dry-run  # report without marking seen
pnpm --dir ~/.claude/skills/pr-triage triage --json     # machine-readable

pnpm --dir ~/.claude/skills/pr-triage stats             # team PR stats, 30 days
pnpm --dir ~/.claude/skills/pr-triage stats --days 90
```

The first `stats` run fetches history and is slow; later runs update incrementally.

Stats are medians, with `n=` sample counts. The AI-usage figure is a **labeled
heuristic** — verbosity plus explicit AI markers, scored 0–100 per time bucket. It is
a proxy, not proof, and is best read as a trend rather than a measurement of any
individual.

## State

Two files are written at runtime and are gitignored, since both are per-user and one
holds per-author metrics about real people:

- `state.json` — triage memory, one snapshot per open PR. Delete it to reset (every
  PR surfaces again); delete a single key to "unsee" one PR.
- `stats-history.json` — stats cache. Delete it to force a full refetch.

## Development

```bash
pnpm --dir ~/.claude/skills/pr-triage test
```

Pure logic lives in `scripts/lib.ts` and `scripts/stats-lib.ts` and is unit-tested
with `node:test`. The CLI shells (`triage.ts`, `stats.ts`) handle `gh` subprocess
calls and file IO. `design.md` and `plan.md` are the original design and
implementation notes.

Note that `pnpm-workspace.yaml` (`lockfile: false`, `verifyDepsBeforeRun: false`) is
what stops pnpm from materializing a `node_modules` and lockfile — keep it.
