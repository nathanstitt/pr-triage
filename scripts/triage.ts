#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    applyPendingReview, computeAction, describeChanges, discoverRequestedRepos, formatReport,
    makeSnapshot, needsPendingCheck, prKey,
    type Change, type RawPr, type SearchHit, type Snapshot, type State, type TriageItem,
} from './lib.ts'

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_PATH = join(SKILL_DIR, 'config.json')
const STATE_PATH = join(SKILL_DIR, 'state.json')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const asJson = argv.includes('--json')

const PR_FIELDS =
    'number,title,author,isDraft,headRefOid,url,reviewDecision,reviewRequests,comments,reviews,statusCheckRollup'

// gh's default --limit for `pr list` is 30, which silently drops PRs beyond
// that count: seen PRs beyond 30 vanish from nextPrs (as if closed), then
// re-surface as "new" on a later run once the count dips back under 30. 40
// stays within GitHub's GraphQL node budget for this field set (observed
// ceiling ~48-49; see stats.ts) while covering more repos before truncating.
const PR_LIST_LIMIT = 40

function gh(...ghArgs: string[]): string {
    return execFileSync('gh', ghArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function loadState(): { state: State; firstRun: boolean } {
    if (!existsSync(STATE_PATH)) return { state: { prs: {} }, firstRun: true }
    try {
        const state = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State
        return { state: { prs: {}, ...state }, firstRun: false }
    } catch {
        return { state: { prs: {} }, firstRun: true }
    }
}

const { repos: configuredRepos } = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { repos: string[] }
const { state, firstRun } = loadState()
const login = state.login ?? gh('api', 'user', '-q', '.login').trim()
const now = new Date().toISOString()

const errors: string[] = []

// A review request is a direct ask and can arrive in a repo the config never lists.
// Discovered repos are appended to the walk rather than handled separately, so their
// PRs get the same snapshotting and change detection as the configured ones.
const REQUEST_STALE_DAYS = 180
const staleBefore = new Date(Date.now() - REQUEST_STALE_DAYS * 86_400_000).toISOString()

let requestedByRepo = new Map<string, Set<number>>()
try {
    const hits = JSON.parse(
        gh('search', 'prs', '--review-requested', '@me', '--state', 'open', '--limit', '100',
           '--json', 'number,repository,updatedAt')
    ) as SearchHit[]
    requestedByRepo = discoverRequestedRepos(hits, configuredRepos, staleBefore)
} catch (err) {
    errors.push(
        `Could not search for review requests outside the configured repos: ${(err as Error).message.split('\n')[0]} — configured repos are unaffected.`
    )
}

const repos = [...configuredRepos, ...requestedByRepo.keys()]
const items: TriageItem[] = []
const nextPrs: Record<string, Snapshot> = {}

/**
 * REST, not GraphQL: GraphQL's `reviews` connection omits unsubmitted drafts
 * entirely (verified against a PR holding a known PENDING review), so it cannot
 * answer this at all — which rules out batching the whole repo in one query.
 *
 * Pinned to the head sha so a draft written against an older commit stops
 * surfacing once the branch moves on.
 */
function hasPendingReview(repo: string, number: number, headSha: string): boolean {
    try {
        // --paginate walks past the API's 30-per-page default so a pending review
        // isn't missed on PRs with a long review history; --slurp wraps each page
        // in its own array, so the result must be flattened before use.
        const pages = JSON.parse(
            gh('api', '--paginate', '--slurp', `repos/${repo}/pulls/${number}/reviews`)
        ) as Array<Array<{ state: string; user: { login: string } | null; commit_id: string }>>
        return pages
            .flat()
            .some((r) => r.state === 'PENDING' && r.user?.login === login && r.commit_id === headSha)
    } catch {
        errors.push(`Could not check for a pending review on ${prKey(repo, number)}; showing the plain action.`)
        return false
    }
}

for (const repo of repos) {
    let prs: RawPr[]
    try {
        prs = JSON.parse(
            gh('pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', PR_FIELDS)
        )
        if (prs.length === PR_LIST_LIMIT) {
            errors.push(
                `${repo}: possible truncation — repo has ≥${PR_LIST_LIMIT} open PRs; triage may be incomplete.`
            )
        }
    } catch (err) {
        errors.push(`Failed to fetch PRs for ${repo}: ${(err as Error).message.split('\n')[0]} — its saved state is untouched.`)
        for (const [key, snapshot] of Object.entries(state.prs)) {
            if (key.startsWith(`${repo}#`)) nextPrs[key] = snapshot
        }
        continue
    }
    // A configured repo is watched wholesale; a discovered one was only reached because
    // a specific PR asks for me, so everything else in it stays out of the report.
    // Without this, adding a repo by discovery would drag in every unrelated open PR.
    const onlyRequested = requestedByRepo.get(repo)
    if (onlyRequested) prs = prs.filter((pr) => onlyRequested.has(pr.number))
    for (const pr of prs) {
        const key = prKey(repo, pr.number)
        const prev = state.prs[key]
        const snapshot = makeSnapshot(pr, login, now)
        const isOwn = pr.author?.login === login
        const isNew = prev === undefined
        const changes: Change[] = prev ? describeChanges(prev, snapshot, repo) : []
        const result = computeAction({ isOwn, isNew, snapshot, changes })
        // Checked even when result is null: a draft leaves no trace in the counts, so
        // a PR with no other activity is exactly where one hides (Gap 1).
        const pending = needsPendingCheck({ isOwn, snapshot }) && hasPendingReview(repo, pr.number, snapshot.headSha)
        const final = pending ? applyPendingReview(result) : result
        if (final) {
            items.push({
                key, repo,
                number: pr.number, title: pr.title, author: pr.author?.login ?? 'ghost', url: pr.url,
                isOwn, isNew, changes, myReviewState: snapshot.myReviewState,
                hasPendingReview: pending, ...final,
            })
        } else if (prev) {
            snapshot.surfacedAt = prev.surfacedAt
        }
        nextPrs[key] = snapshot
    }
}

// A discovered repo is only walked while its review request is open and fresh. Once the
// request is dismissed or ages past the cutoff, the repo drops out of `repos` and its
// saved snapshots would vanish with it — so a re-requested PR would come back as "new"
// and re-surface work already dealt with. Carrying the entries forward keeps it seen.
// Configured repos are unaffected: they are always walked, so their keys are rewritten
// above, and a genuinely closed PR still ages out of the walk as before.
const walked = new Set(repos)
for (const [key, snapshot] of Object.entries(state.prs)) {
    const repo = key.slice(0, key.lastIndexOf('#'))
    if (!walked.has(repo) && !(key in nextPrs)) nextPrs[key] = snapshot
}

if (asJson) {
    console.log(JSON.stringify({ firstRun, items, errors }, null, 2))
} else {
    console.log(formatReport(items, { firstRun, errors }))
}

if (dryRun) {
    if (!asJson) console.log('\n(dry run — nothing marked as seen)')
} else {
    const next: State = { login, prs: nextPrs }
    writeFileSync(STATE_PATH + '.tmp', JSON.stringify(next, null, 2) + '\n')
    renameSync(STATE_PATH + '.tmp', STATE_PATH)
}
