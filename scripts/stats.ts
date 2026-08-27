#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    aiUsageTrend, countMarkdownStructure, formatStatsReport, hasAiMarkerText, myReviewLatency, responseTimes, velocity,
    type HistoryPr, type StatsHistory,
} from './stats-lib.ts'

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_PATH = join(SKILL_DIR, 'config.json')
const HISTORY_PATH = join(SKILL_DIR, 'stats-history.json')

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const daysFlag = argv.indexOf('--days')
const days = daysFlag === -1 ? 30 : Number(argv[daysFlag + 1])
if (!Number.isFinite(days) || days <= 0) {
    console.error('--days requires a positive number')
    process.exit(1)
}

const DAY_MS = 86_400_000
const now = new Date()
const windowStart = new Date(now.getTime() - days * DAY_MS).toISOString()

function gh(...ghArgs: string[]): string {
    return execFileSync('gh', ghArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

interface RawHistoryPr {
    number: number
    author: { login: string } | null
    createdAt: string
    mergedAt: string | null
    updatedAt: string
    body: string | null
    reviews: Array<{ author?: { login?: string }; state?: string; submittedAt?: string }>
    comments: Array<{ author?: { login?: string }; createdAt?: string; body?: string }>
    commits: Array<{ committedDate?: string; messageHeadline?: string; messageBody?: string }>
}

function trimPr(raw: RawHistoryPr): HistoryPr {
    return {
        author: raw.author?.login ?? 'ghost',
        createdAt: raw.createdAt,
        mergedAt: raw.mergedAt,
        updatedAt: raw.updatedAt,
        bodyChars: (raw.body ?? '').length,
        bodyStructure: countMarkdownStructure(raw.body ?? ''),
        hasAiMarker: hasAiMarkerText(raw.body ?? ''),
        reviews: (raw.reviews ?? []).map((r) => ({
            author: r.author?.login, state: r.state, submittedAt: r.submittedAt,
        })),
        comments: (raw.comments ?? []).map((c) => ({
            author: c.author?.login, createdAt: c.createdAt, chars: (c.body ?? '').length,
        })),
        commits: (raw.commits ?? []).map((c) => {
            const msg = (c.messageHeadline ?? '') + '\n' + (c.messageBody ?? '')
            return {
                committedDate: c.committedDate,
                messageChars: msg.trim().length,
                hasAiMarker: hasAiMarkerText(msg),
            }
        }),
    }
}

const CACHE_VERSION = 2

function loadHistory(): StatsHistory | null {
    if (!existsSync(HISTORY_PATH)) return null
    try {
        const parsed = JSON.parse(readFileSync(HISTORY_PATH, 'utf8')) as StatsHistory
        if (parsed.version !== CACHE_VERSION) return null
        return parsed
    } catch {
        return null
    }
}

const STAT_FIELDS = 'number,author,createdAt,mergedAt,updatedAt,reviews,comments,commits,body'

// gh's underlying GraphQL query prices --limit against every nested connection
// requested in --json (reviews, comments, commits each default to a 100-item
// page). With this field set, GitHub's 500,000-node budget is exhausted around
// --limit 49, well below a single repo's PR count, and gh does not paginate
// around that error — it just fails the whole request. So we page manually
// with a safe per-page size, walking forward via `updated:>=` + sort:updated-asc
// and merging pages (the Record keyed by repo#number makes re-fetching the
// boundary PR on each page idempotent).
const PAGE_SIZE = 40
// Highest --limit that stays under GitHub's GraphQL node budget for this field
// set (observed ceiling ~48-49). Used only to try to fit an entire tied-
// timestamp page in one request; never used as the normal page size.
const MAX_SAFE_LIMIT = 48
const MAX_PAGES_PER_REPO = 500

function fetchAllPages(repo: string, sinceIso: string, errors: string[]): RawHistoryPr[] {
    const all: RawHistoryPr[] = []
    let cursor = sinceIso
    for (let pageNum = 0; pageNum < MAX_PAGES_PER_REPO; pageNum++) {
        const page = JSON.parse(
            gh('pr', 'list', '--repo', repo, '--state', 'all', '--limit', String(PAGE_SIZE),
                '--search', `updated:>=${cursor} sort:updated-asc`, '--json', STAT_FIELDS)
        ) as RawHistoryPr[]
        all.push(...page)
        if (page.length < PAGE_SIZE) return all

        const last = page[page.length - 1].updatedAt
        // A full page whose every row shares the last row's timestamp means the
        // cursor can't advance past it at PAGE_SIZE — re-querying `updated:>=last`
        // would return the same tied set forever. Try to swallow the whole tie in
        // one larger request instead of looping on it.
        if (page[0].updatedAt === last) {
            const tied = JSON.parse(
                gh('pr', 'list', '--repo', repo, '--state', 'all', '--limit', String(MAX_SAFE_LIMIT),
                    '--search', `updated:>=${last} sort:updated-asc`, '--json', STAT_FIELDS)
            ) as RawHistoryPr[]
            const stillTiedThroughout = tied.length === MAX_SAFE_LIMIT && tied[tied.length - 1].updatedAt === last
            if (stillTiedThroughout) {
                for (const raw of tied) if (!all.some((p) => p.number === raw.number)) all.push(raw)
                errors.push(
                    `${repo}: more than ${MAX_SAFE_LIMIT} PRs share updatedAt=${last}; ` +
                    `kept the first ${MAX_SAFE_LIMIT} of the tied set and skipped past the timestamp ` +
                    `to avoid hanging (the rest sharing that timestamp were not fetched — possible gap).`
                )
                cursor = new Date(new Date(last).getTime() + 1000).toISOString()
            } else {
                for (const raw of tied) if (!all.some((p) => p.number === raw.number)) all.push(raw)
                const beyondTie = tied.filter((raw) => raw.updatedAt !== last)
                cursor = beyondTie.length > 0
                    ? beyondTie[beyondTie.length - 1].updatedAt
                    : new Date(new Date(last).getTime() + 1000).toISOString()
            }
            continue
        }
        cursor = last
    }
    errors.push(`${repo}: hit the ${MAX_PAGES_PER_REPO}-page fetch cap; results may be incomplete.`)
    return all
}

const prior = loadHistory()
const fullRefetch = prior === null || windowStart < prior.coverageStart
const fetchSince = fullRefetch
    ? windowStart
    : new Date(new Date(prior.fetchedAt).getTime() - DAY_MS).toISOString()

const history: StatsHistory = fullRefetch
    ? { version: CACHE_VERSION, fetchedAt: now.toISOString(), coverageStart: windowStart, prs: {} }
    : { ...(prior as StatsHistory), fetchedAt: now.toISOString() }

const { repos } = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { repos: string[] }
const errors: string[] = []
for (const repo of repos) {
    try {
        const fetched = fetchAllPages(repo, fetchSince, errors)
        for (const raw of fetched) history.prs[`${repo}#${raw.number}`] = trimPr(raw)
    } catch (err) {
        errors.push(`Failed to fetch history for ${repo}: ${(err as Error).message.split('\n')[0]}`)
    }
}

// A failed (or partially-tied/truncated) fetch must not advance fetchedAt to
// now: the next incremental run starts from `fetchedAt - 1 day`, so bumping
// it here on a failure would permanently skip whatever that repo missed —
// its older activity would never be re-covered by a later run. Only mark the
// window as fully fetched once every repo came back clean.
history.fetchedAt = errors.length === 0 ? now.toISOString() : (prior?.fetchedAt ?? windowStart)

for (const [key, pr] of Object.entries(history.prs)) {
    if (pr.updatedAt < history.coverageStart && (!pr.mergedAt || pr.mergedAt < history.coverageStart)) {
        delete history.prs[key]
    }
}

const login = gh('api', 'user', '-q', '.login').trim()
const prs = Object.values(history.prs)
const responses = responseTimes(prs, windowStart)
const velocities = velocity(prs, windowStart)
const myLatencies = myReviewLatency(prs, login, windowStart)
const aiUsage = aiUsageTrend(prs, windowStart, days)

if (asJson) {
    console.log(JSON.stringify({ days, responses, velocities, myLatencies, aiUsage, errors }, null, 2))
} else {
    console.log(formatStatsReport({ days, responses, velocities, myLatencies, aiUsage }))
    for (const err of errors) console.log(`\nWARNING: ${err}`)
}

writeFileSync(HISTORY_PATH + '.tmp', JSON.stringify(history, null, 2) + '\n')
renameSync(HISTORY_PATH + '.tmp', HISTORY_PATH)
