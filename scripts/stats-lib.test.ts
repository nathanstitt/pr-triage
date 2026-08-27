import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    formatDuration, formatStatsReport, hoursBetween, median,
    myReviewLatency, responseTimes, velocity, type HistoryPr,
    AI_MARKER_RE, hasAiMarkerText, countMarkdownStructure, clamp01, prAiScore, aiUsageTrend,
    BOT_AUTHOR_RE,
    type HistoryCommit, type HistoryComment,
} from './stats-lib.ts'

function historyPr(overrides: Partial<HistoryPr> = {}): HistoryPr {
    return {
        author: 'alice',
        createdAt: '2026-08-01T00:00:00Z',
        mergedAt: null,
        updatedAt: '2026-08-01T00:00:00Z',
        reviews: [],
        comments: [],
        commits: [],
        ...overrides,
    }
}

const SINCE = '2026-07-08T00:00:00Z'

test('median handles empty, odd, and even inputs', () => {
    assert.equal(median([]), null)
    assert.equal(median([3, 1, 2]), 2)
    assert.equal(median([1, 2, 3, 10]), 2.5)
})

test('hoursBetween and formatDuration', () => {
    assert.equal(hoursBetween('2026-08-01T00:00:00Z', '2026-08-01T06:00:00Z'), 6)
    assert.equal(formatDuration(0.5), '30m')
    assert.equal(formatDuration(5.2), '5.2h')
    assert.equal(formatDuration(72), '3.0d')
})

test('responseTimes measures feedback to first author comment or commit', () => {
    const pr = historyPr({
        reviews: [{ author: 'nathan', state: 'CHANGES_REQUESTED', submittedAt: '2026-08-01T10:00:00Z' }],
        comments: [{ author: 'alice', createdAt: '2026-08-01T12:00:00Z' }],
        commits: [{ committedDate: '2026-08-01T15:00:00Z' }],
    })
    assert.deepEqual(responseTimes([pr], SINCE), { alice: [2] })
})

test('responseTimes uses a commit push as the response when no comment exists', () => {
    const pr = historyPr({
        reviews: [{ author: 'nathan', state: 'COMMENTED', submittedAt: '2026-08-01T10:00:00Z' }],
        commits: [{ committedDate: '2026-08-01T13:00:00Z' }],
    })
    assert.deepEqual(responseTimes([pr], SINCE), { alice: [3] })
})

test('responseTimes ignores approvals, self-reviews, out-of-window reviews, and unanswered feedback', () => {
    const approvals = historyPr({
        reviews: [{ author: 'nathan', state: 'APPROVED', submittedAt: '2026-08-01T10:00:00Z' }],
        comments: [{ author: 'alice', createdAt: '2026-08-01T11:00:00Z' }],
    })
    const selfReview = historyPr({
        reviews: [{ author: 'alice', state: 'COMMENTED', submittedAt: '2026-08-01T10:00:00Z' }],
        comments: [{ author: 'alice', createdAt: '2026-08-01T11:00:00Z' }],
    })
    const stale = historyPr({
        reviews: [{ author: 'nathan', state: 'COMMENTED', submittedAt: '2026-07-01T10:00:00Z' }],
        comments: [{ author: 'alice', createdAt: '2026-07-01T11:00:00Z' }],
    })
    const unanswered = historyPr({
        reviews: [{ author: 'nathan', state: 'COMMENTED', submittedAt: '2026-08-01T10:00:00Z' }],
    })
    assert.deepEqual(responseTimes([approvals, selfReview, stale, unanswered], SINCE), {})
})

test('velocity collects opened-to-merged durations for PRs merged in window', () => {
    const merged = historyPr({
        createdAt: '2026-08-01T00:00:00Z', mergedAt: '2026-08-02T00:00:00Z',
    })
    const mergedEarlier = historyPr({
        author: 'bob', createdAt: '2026-06-01T00:00:00Z', mergedAt: '2026-07-01T00:00:00Z',
    })
    const open = historyPr({ author: 'bob' })
    assert.deepEqual(velocity([merged, mergedEarlier, open], SINCE), { alice: [24] })
})

test('myReviewLatency measures creation to my first review on others PRs in window', () => {
    const reviewed = historyPr({
        createdAt: '2026-08-01T00:00:00Z',
        reviews: [
            { author: 'nathan', state: 'COMMENTED', submittedAt: '2026-08-01T08:00:00Z' },
            { author: 'nathan', state: 'APPROVED', submittedAt: '2026-08-02T00:00:00Z' },
        ],
    })
    const mine = historyPr({
        author: 'nathan',
        reviews: [{ author: 'alice', state: 'APPROVED', submittedAt: '2026-08-01T08:00:00Z' }],
    })
    const unreviewed = historyPr({})
    const old = historyPr({
        createdAt: '2026-07-01T00:00:00Z',
        reviews: [{ author: 'nathan', state: 'COMMENTED', submittedAt: '2026-08-01T00:00:00Z' }],
    })
    assert.deepEqual(myReviewLatency([reviewed, mine, unreviewed, old], 'nathan', SINCE), [8])
})

test('formatStatsReport renders all three sections with medians and counts', () => {
    const report = formatStatsReport({
        days: 30,
        responses: { alice: [2, 4, 100] },
        velocities: { alice: [24, 96] },
        myLatencies: [8, 10],
        aiUsage: {},
    })
    assert.match(report, /last 30 days/)
    assert.match(report, /alice\s+4\.0h\s+\(n=3\)/)
    assert.match(report, /alice\s+2 merged, median 2\.5d/)
    assert.match(report, /median 9\.0h\s+\(n=2\)/)
})

test('formatStatsReport handles empty data', () => {
    const report = formatStatsReport({
        days: 30,
        responses: {},
        velocities: {},
        myLatencies: [],
        aiUsage: {},
    })
    assert.match(report, /no samples/)
    assert.match(report, /no merged PRs/)
    assert.match(report, /no reviews in window/)
    assert.match(report, /no data/)
})

test('AI_MARKER_RE matches positive cases', () => {
    assert.match('Co-Authored-By: Claude <noreply@anthropic.com>', AI_MARKER_RE)
    assert.match('co-authored-by: claude', AI_MARKER_RE)
    assert.match('🤖 Generated with [Claude Code]', AI_MARKER_RE)
    assert.match('co-authored-by: GitHub Copilot', AI_MARKER_RE)
    assert.match('Generated with Cursor', AI_MARKER_RE)
    assert.match('co-authored-by: devin', AI_MARKER_RE)
    assert.match('co-authored-by: chatgpt', AI_MARKER_RE)
})

test('AI_MARKER_RE rejects negative cases', () => {
    assert.doesNotMatch('generated with love', AI_MARKER_RE)
    assert.doesNotMatch('robot arm refactor', AI_MARKER_RE)
    assert.doesNotMatch('Copilot is installed', AI_MARKER_RE)
})

test('hasAiMarkerText uses AI_MARKER_RE', () => {
    assert.equal(hasAiMarkerText('co-authored-by: claude'), true)
    assert.equal(hasAiMarkerText('generated with love'), false)
})

test('countMarkdownStructure counts headers, bullets, numbers, and table rows', () => {
    const mixed = `# Header 1
## Header 2
Some text
- bullet
* also bullet
+ plus bullet
1. numbered
2. also numbered
| table | row |
plain text
### Another header
`
    const count = countMarkdownStructure(mixed)
    // 3 headers (# ## ###) + 3 bullets (- * +) + 2 numbers (1. 2.) + 1 table = 9
    assert.equal(count, 9)
})

test('clamp01 clamps to [0,1]', () => {
    assert.equal(clamp01(-0.5), 0)
    assert.equal(clamp01(0.5), 0.5)
    assert.equal(clamp01(1.5), 1)
})

test('prAiScore: all-zero PR scores 0', () => {
    const pr: HistoryPr = {
        author: 'alice',
        createdAt: '2026-08-01T00:00:00Z',
        mergedAt: null,
        updatedAt: '2026-08-01T00:00:00Z',
        reviews: [],
        comments: [],
        commits: [],
        bodyChars: 0,
        bodyStructure: 0,
        hasAiMarker: false,
    }
    const score = prAiScore(pr)
    assert.equal(score, 0)
})

test('prAiScore: marker floors to >= 0.9', () => {
    const pr: HistoryPr = {
        author: 'alice',
        createdAt: '2026-08-01T00:00:00Z',
        mergedAt: null,
        updatedAt: '2026-08-01T00:00:00Z',
        reviews: [],
        comments: [],
        commits: [],
        bodyChars: 0,
        bodyStructure: 0,
        hasAiMarker: true,
    }
    const score = prAiScore(pr)
    assert(score >= 0.9, `Expected score >= 0.9, got ${score}`)
})

test('prAiScore: saturation near 1.0 with high values', () => {
    const pr: HistoryPr = {
        author: 'alice',
        createdAt: '2026-08-01T00:00:00Z',
        mergedAt: null,
        updatedAt: '2026-08-01T00:00:00Z',
        reviews: [],
        comments: [],
        commits: [
            { committedDate: '2026-08-01T01:00:00Z', messageChars: 400, hasAiMarker: false },
        ],
        bodyChars: 3000,
        bodyStructure: 12,
        hasAiMarker: false,
    }
    const score = prAiScore(pr)
    assert(score > 0.99, `Expected score > 0.99, got ${score}`)
})

test('aiUsageTrend: two PRs in different weeks land in different buckets', () => {
    const pr1: HistoryPr = {
        author: 'alice',
        createdAt: '2026-07-10T00:00:00Z',
        mergedAt: null,
        updatedAt: '2026-07-10T00:00:00Z',
        reviews: [],
        comments: [],
        commits: [{ committedDate: '2026-07-10T00:00:00Z', messageChars: 100, hasAiMarker: false }],
        bodyChars: 500,
        bodyStructure: 2,
        hasAiMarker: false,
    }
    const pr2: HistoryPr = {
        author: 'alice',
        createdAt: '2026-07-17T00:00:00Z',
        mergedAt: null,
        updatedAt: '2026-07-17T00:00:00Z',
        reviews: [],
        comments: [],
        commits: [{ committedDate: '2026-07-17T00:00:00Z', messageChars: 100, hasAiMarker: false }],
        bodyChars: 500,
        bodyStructure: 2,
        hasAiMarker: false,
    }
    const result = aiUsageTrend([pr1, pr2], '2026-07-10T00:00:00Z', 30)
    assert(result.alice, 'Expected alice in result')
    assert.equal(result.alice.buckets.length, 2, 'Expected 2 buckets')
    assert.equal(result.alice.buckets[0].bucketStart, '2026-07-10')
    assert.equal(result.alice.buckets[1].bucketStart, '2026-07-17')
})

test('aiUsageTrend: days=120 uses 30-day buckets', () => {
    const pr1: HistoryPr = {
        author: 'bob',
        createdAt: '2026-07-10T00:00:00Z',
        mergedAt: null,
        updatedAt: '2026-07-10T00:00:00Z',
        reviews: [],
        comments: [],
        commits: [{ committedDate: '2026-07-10T00:00:00Z', messageChars: 50, hasAiMarker: false }],
        bodyChars: 200,
        bodyStructure: 1,
        hasAiMarker: false,
    }
    const pr2: HistoryPr = {
        author: 'bob',
        createdAt: '2026-08-09T00:00:00Z',
        mergedAt: null,
        updatedAt: '2026-08-09T00:00:00Z',
        reviews: [],
        comments: [],
        commits: [{ committedDate: '2026-08-09T00:00:00Z', messageChars: 50, hasAiMarker: false }],
        bodyChars: 200,
        bodyStructure: 1,
        hasAiMarker: false,
    }
    const result = aiUsageTrend([pr1, pr2], '2026-07-10T00:00:00Z', 120)
    assert(result.bob, 'Expected bob in result')
    assert.equal(result.bob.buckets.length, 2, 'Expected 2 buckets with 30-day bucket size')
})

test('aiUsageTrend: comments-only dev gets buckets with markerRate null', () => {
    const pr: HistoryPr = {
        author: 'alice',
        createdAt: '2026-07-10T00:00:00Z',
        mergedAt: null,
        updatedAt: '2026-07-10T00:00:00Z',
        reviews: [],
        comments: [
            {
                author: 'bob',
                createdAt: '2026-07-10T12:00:00Z',
                chars: 100,
            },
        ],
        commits: [],
        bodyChars: 200,
        bodyStructure: 1,
        hasAiMarker: false,
    }
    const result = aiUsageTrend([pr], '2026-07-10T00:00:00Z', 30)
    assert(result.bob, 'Expected bob in result')
    assert.equal(result.bob.markerRate, null, 'Expected markerRate null for comments-only dev')
})

test('aiUsageTrend: markerRate 50% for 1-of-2 marker PRs', () => {
    const pr1: HistoryPr = {
        author: 'charlie',
        createdAt: '2026-07-10T00:00:00Z',
        mergedAt: null,
        updatedAt: '2026-07-10T00:00:00Z',
        reviews: [],
        comments: [],
        commits: [{ committedDate: '2026-07-10T00:00:00Z', messageChars: 50, hasAiMarker: true }],
        bodyChars: 200,
        bodyStructure: 1,
        hasAiMarker: false,
    }
    const pr2: HistoryPr = {
        author: 'charlie',
        createdAt: '2026-07-17T00:00:00Z',
        mergedAt: null,
        updatedAt: '2026-07-17T00:00:00Z',
        reviews: [],
        comments: [],
        commits: [{ committedDate: '2026-07-17T00:00:00Z', messageChars: 50, hasAiMarker: false }],
        bodyChars: 200,
        bodyStructure: 1,
        hasAiMarker: false,
    }
    const result = aiUsageTrend([pr1, pr2], '2026-07-10T00:00:00Z', 30)
    assert.equal(result.charlie.markerRate, 50)
})

test('aiUsageTrend: bucket with PRs and comments uses 0.75/0.25 blend', () => {
    const pr: HistoryPr = {
        author: 'dave',
        createdAt: '2026-07-10T00:00:00Z',
        mergedAt: null,
        updatedAt: '2026-07-10T00:00:00Z',
        reviews: [],
        comments: [
            {
                author: 'dave',
                createdAt: '2026-07-10T12:00:00Z',
                chars: 100,
            },
        ],
        commits: [{ committedDate: '2026-07-10T00:00:00Z', messageChars: 100, hasAiMarker: false }],
        bodyChars: 500,
        bodyStructure: 3,
        hasAiMarker: false,
    }
    const result = aiUsageTrend([pr], '2026-07-10T00:00:00Z', 30)
    assert(result.dave, 'Expected dave in result')
    assert.equal(result.dave.buckets.length, 1)
    const bucket = result.dave.buckets[0]
    // Derivation: prScore = 0.4*log10(501)/log10(3000) + 0.2*0.25 + 0.4*log10(101)/log10(400) ≈ 0.668
    // sComment = log10(101)/log10(800) ≈ 0.691
    // blend = 0.75*0.668 + 0.25*0.691 = 0.501 + 0.173 ≈ 0.674
    // Math.round(100 * 0.674) = 67
    assert.equal(bucket.score, 67)
})

test('BOT_AUTHOR_RE matches known bot accounts', () => {
    assert.match('app/dependabot', BOT_AUTHOR_RE)
    assert.match('dependabot', BOT_AUTHOR_RE)
    assert.match('dependabot[bot]', BOT_AUTHOR_RE)
    assert.match('github-actions', BOT_AUTHOR_RE)
    assert.match('github-actions[bot]', BOT_AUTHOR_RE)
    assert.match('renovate', BOT_AUTHOR_RE)
    assert.match('renovate[bot]', BOT_AUTHOR_RE)
    assert.match('app/some-custom-bot', BOT_AUTHOR_RE)
    assert.match('some-custom[bot]', BOT_AUTHOR_RE)
})

test('BOT_AUTHOR_RE rejects human accounts', () => {
    assert.doesNotMatch('alice', BOT_AUTHOR_RE)
    assert.doesNotMatch('nathan', BOT_AUTHOR_RE)
    assert.doesNotMatch('bob-smith', BOT_AUTHOR_RE)
})

test('aiUsageTrend: excludes bot-authored PRs and bot comments, keeps human PRs', () => {
    const botPr: HistoryPr = {
        author: 'app/dependabot',
        createdAt: '2026-07-10T00:00:00Z',
        mergedAt: null,
        updatedAt: '2026-07-10T00:00:00Z',
        reviews: [],
        comments: [
            {
                author: 'github-actions',
                createdAt: '2026-07-10T01:00:00Z',
                chars: 500,
            },
        ],
        commits: [{ committedDate: '2026-07-10T00:00:00Z', messageChars: 50, hasAiMarker: false }],
        bodyChars: 11000,
        bodyStructure: 40,
        hasAiMarker: false,
    }
    const humanPr: HistoryPr = {
        author: 'alice',
        createdAt: '2026-07-10T00:00:00Z',
        mergedAt: null,
        updatedAt: '2026-07-10T00:00:00Z',
        reviews: [],
        comments: [],
        commits: [{ committedDate: '2026-07-10T00:00:00Z', messageChars: 100, hasAiMarker: false }],
        bodyChars: 500,
        bodyStructure: 2,
        hasAiMarker: false,
    }
    const result = aiUsageTrend([botPr, humanPr], '2026-07-10T00:00:00Z', 30)
    assert.equal(result['app/dependabot'], undefined, 'Expected app/dependabot excluded')
    assert.equal(result['dependabot'], undefined, 'Expected dependabot excluded')
    assert.equal(result['github-actions'], undefined, 'Expected github-actions excluded')
    assert(result.alice, 'Expected human PR author alice to still appear')
})
