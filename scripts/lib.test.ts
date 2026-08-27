import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prKey, makeSnapshot, describeChanges, computeAction, formatReport, needsPendingCheck, applyPendingReview, discoverRequestedRepos, type RawPr, type Snapshot, type Change, type ChangeKind, type TriageItem, type SearchHit } from './lib.ts'

test('prKey formats repo#number', () => {
    assert.equal(prKey('safeinsights/management-app', 123), 'safeinsights/management-app#123')
})

function rawPr(overrides: Partial<RawPr> = {}): RawPr {
    return {
        number: 1,
        title: 'Test PR',
        url: 'https://github.com/safeinsights/management-app/pull/1',
        author: { login: 'alice' },
        isDraft: false,
        headRefOid: 'aaa111',
        reviewDecision: '',
        reviewRequests: [],
        comments: [],
        reviews: [],
        statusCheckRollup: [],
        ...overrides,
    }
}

const NOW = '2026-08-07T12:00:00Z'

test('makeSnapshot captures counts and head sha', () => {
    const pr = rawPr({
        headRefOid: 'abc123',
        isDraft: true,
        comments: [{ author: { login: 'bob' } }, { author: { login: 'carol' } }],
        reviews: [{ author: { login: 'bob' }, state: 'APPROVED' }],
        reviewDecision: 'APPROVED',
    })
    const snap = makeSnapshot(pr, 'nathan', NOW)
    assert.equal(snap.headSha, 'abc123')
    assert.equal(snap.isDraft, true)
    assert.equal(snap.commentCount, 2)
    assert.equal(snap.reviewCount, 1)
    assert.equal(snap.reviewDecision, 'APPROVED')
    assert.equal(snap.surfacedAt, NOW)
})

test('makeSnapshot counts my own comments and reviews separately', () => {
    const pr = rawPr({
        comments: [{ author: { login: 'bob' } }, { author: { login: 'nathan' } }],
        reviews: [
            { author: { login: 'nathan' }, state: 'APPROVED', submittedAt: NOW },
            { author: { login: 'bob' }, state: 'COMMENTED', submittedAt: NOW },
        ],
    })
    const snap = makeSnapshot(pr, 'nathan', NOW)
    assert.equal(snap.commentCount, 2)
    assert.equal(snap.othersCommentCount, 1)
    assert.equal(snap.reviewCount, 2)
    assert.equal(snap.othersReviewCount, 1)
})

// A coverage bot posting on every push is not new information.
test('makeSnapshot excludes bot comments from the others count', () => {
    const pr = rawPr({
        comments: [
            { author: { login: 'github-actions' } },
            { author: { login: 'dependabot[bot]' } },
            { author: { login: 'bob' } },
        ],
    })
    const snap = makeSnapshot(pr, 'nathan', NOW)
    assert.equal(snap.commentCount, 3)
    assert.equal(snap.othersCommentCount, 1)
})

test('makeSnapshot detects review requested from me', () => {
    const pr = rawPr({ reviewRequests: [{ login: 'someone' }, { login: 'nathan' }] })
    assert.equal(makeSnapshot(pr, 'nathan', NOW).reviewRequestedFromMe, true)
    assert.equal(makeSnapshot(rawPr(), 'nathan', NOW).reviewRequestedFromMe, false)
})

test('makeSnapshot tracks failing CI only on own PRs', () => {
    const failing = [{ conclusion: 'FAILURE' }]
    const own = rawPr({ author: { login: 'nathan' }, statusCheckRollup: failing })
    const theirs = rawPr({ author: { login: 'alice' }, statusCheckRollup: failing })
    assert.equal(makeSnapshot(own, 'nathan', NOW).ciFailing, true)
    assert.equal(makeSnapshot(theirs, 'nathan', NOW).ciFailing, false)
})

test('makeSnapshot treats ERROR status contexts and null rollup correctly', () => {
    const errored = rawPr({ author: { login: 'nathan' }, statusCheckRollup: [{ state: 'ERROR' }] })
    const noChecks = rawPr({ author: { login: 'nathan' }, statusCheckRollup: null })
    assert.equal(makeSnapshot(errored, 'nathan', NOW).ciFailing, true)
    assert.equal(makeSnapshot(noChecks, 'nathan', NOW).ciFailing, false)
})

test('makeSnapshot handles a null author (deleted account) without throwing', () => {
    const pr = rawPr({ author: null, statusCheckRollup: [{ conclusion: 'FAILURE' }] })
    assert.doesNotThrow(() => makeSnapshot(pr, 'nathan', NOW))
    assert.equal(makeSnapshot(pr, 'nathan', NOW).ciFailing, false)
})

// Mirrors the plain counts into the others-only fields unless a test overrides them,
// so a case that says "2 new comments" without naming an author still means 2 from
// other people. Cases about my own activity set the others-fields explicitly.
function snap(overrides: Partial<Snapshot> = {}): Snapshot {
    const base = {
        headSha: 'aaa111',
        isDraft: false,
        commentCount: 0,
        reviewCount: 0,
        reviewDecision: '',
        reviewRequestedFromMe: false,
        ciFailing: false,
        surfacedAt: NOW,
        ...overrides,
    }
    return {
        othersCommentCount: base.commentCount,
        othersReviewCount: base.reviewCount,
        ...base,
        ...overrides,
    }
}

test('describeChanges returns empty for identical snapshots', () => {
    assert.deepEqual(describeChanges(snap(), snap()), [])
})

test('describeChanges reports new commits', () => {
    const changes = describeChanges(snap(), snap({ headSha: 'bbb222' }))
    assert.deepEqual(changes, [{ kind: 'commits', text: 'new commits' }])
})

test('describeChanges links a compare view spanning only the new commits', () => {
    const changes = describeChanges(
        snap({ headSha: 'aaa111' }),
        snap({ headSha: 'bbb222' }),
        'safeinsights/management-app'
    )
    assert.deepEqual(changes, [
        {
            kind: 'commits',
            text: 'new commits',
            url: 'https://github.com/safeinsights/management-app/compare/aaa111...bbb222',
        },
    ])
})

test('describeChanges omits the compare url when no repo is supplied', () => {
    const changes = describeChanges(snap(), snap({ headSha: 'bbb222' }))
    assert.equal(changes[0].url, undefined)
})

test('formatReport renders the compare url on its own line', () => {
    const report = formatReport(
        [
            item({
                action: 'update',
                priority: 6,
                changes: [{ kind: 'commits', text: 'new commits', url: 'https://example.test/compare/a...b' }],
            }),
        ],
        { firstRun: false, errors: [] }
    )
    assert.match(report, /diff since last seen: https:\/\/example\.test\/compare\/a\.\.\.b/)
})

test('formatReport omits the diff line when no change carries a url', () => {
    const report = formatReport([item({ action: 'update', priority: 6, changes: [change('comments')] })], {
        firstRun: false,
        errors: [],
    })
    assert.doesNotMatch(report, /diff since last seen/)
})

test('describeChanges reports comment and review deltas with counts', () => {
    const changes = describeChanges(
        snap({ commentCount: 1, reviewCount: 0 }),
        snap({ commentCount: 3, reviewCount: 1 })
    )
    assert.deepEqual(changes, [
        { kind: 'comments', text: '2 new comments' },
        { kind: 'reviews', text: '1 new review' },
    ])
})

test('describeChanges ignores decreasing counts', () => {
    assert.deepEqual(describeChanges(snap({ commentCount: 5 }), snap({ commentCount: 3 })), [])
})

test('describeChanges reports draft transitions', () => {
    assert.deepEqual(describeChanges(snap({ isDraft: true }), snap({ isDraft: false })), [
        { kind: 'ready', text: 'now ready for review' },
    ])
    assert.deepEqual(describeChanges(snap({ isDraft: false }), snap({ isDraft: true })), [
        { kind: 'draft', text: 'converted to draft' },
    ])
})

test('describeChanges reports review re-request and decision change', () => {
    assert.deepEqual(describeChanges(snap(), snap({ reviewRequestedFromMe: true })), [
        { kind: 're-requested', text: 'review requested from you' },
    ])
    assert.deepEqual(describeChanges(snap(), snap({ reviewDecision: 'APPROVED' })), [
        { kind: 'decision', text: 'review decision now approved' },
    ])
})

// management-app#959: the only review on the PR was mine, and it flipped the decision
// to APPROVED. Both showed up as new activity and the PR resurfaced telling me about
// my own approval.
test('describeChanges ignores my own review and the decision it caused', () => {
    const before = snap({ reviewCount: 0, othersReviewCount: 0 })
    const after = snap({
        reviewCount: 1,
        othersReviewCount: 0,
        reviewDecision: 'APPROVED',
        myReviewState: 'APPROVED',
    })
    assert.deepEqual(describeChanges(before, after), [])
})

test('describeChanges ignores my own comments', () => {
    const before = snap({ commentCount: 0, othersCommentCount: 0 })
    const after = snap({ commentCount: 3, othersCommentCount: 0 })
    assert.deepEqual(describeChanges(before, after), [])
})

test('describeChanges still reports a decision someone else moved', () => {
    const before = snap({ myReviewState: 'APPROVED', reviewDecision: 'APPROVED' })
    const after = snap({
        myReviewState: 'APPROVED',
        reviewDecision: 'CHANGES_REQUESTED',
        reviewCount: 1,
        othersReviewCount: 1,
    })
    const kinds = describeChanges(before, after).map((c) => c.kind)
    assert.ok(kinds.includes('decision'))
    assert.ok(kinds.includes('reviews'))
})

test('describeChanges separates my review from a simultaneous one by someone else', () => {
    const before = snap({ reviewCount: 0, othersReviewCount: 0 })
    const after = snap({
        reviewCount: 2,
        othersReviewCount: 1,
        reviewDecision: 'APPROVED',
        myReviewState: 'APPROVED',
    })
    assert.deepEqual(describeChanges(before, after), [{ kind: 'reviews', text: '1 new review' }])
})

// Snapshots saved before the others-counts existed lack both fields; falling back to
// the plain counts keeps one legacy run behaving as it did rather than inventing a delta.
test('describeChanges falls back to plain counts on a pre-upgrade snapshot', () => {
    const legacy = { ...snap({ commentCount: 1, reviewCount: 1 }) } as Snapshot
    delete (legacy as Partial<Snapshot>).othersCommentCount
    delete (legacy as Partial<Snapshot>).othersReviewCount
    const after = snap({ commentCount: 2, reviewCount: 1, othersCommentCount: 2, othersReviewCount: 1 })
    assert.deepEqual(describeChanges(legacy, after), [{ kind: 'comments', text: '1 new comment' }])
})

test('describeChanges reports CI newly failing but not recovery', () => {
    assert.deepEqual(describeChanges(snap(), snap({ ciFailing: true })), [
        { kind: 'ci-failing', text: 'CI now failing' },
    ])
    assert.deepEqual(describeChanges(snap({ ciFailing: true }), snap()), [])
})

const change = (kind: ChangeKind): Change => ({ kind, text: kind })

test('own PR with newly failing CI is fix-ci, priority 1', () => {
    const viaChange = computeAction({
        isOwn: true, isNew: false,
        snapshot: snap({ ciFailing: true }),
        changes: [change('ci-failing')],
    })
    assert.deepEqual(viaChange, { action: 'fix-ci', priority: 1 })
    const viaNew = computeAction({
        isOwn: true, isNew: true, snapshot: snap({ ciFailing: true }), changes: [],
    })
    assert.deepEqual(viaNew, { action: 'fix-ci', priority: 1 })
})

test('own PR newly approved is merge, priority 4', () => {
    const result = computeAction({
        isOwn: true, isNew: false,
        snapshot: snap({ reviewDecision: 'APPROVED' }),
        changes: [change('decision')],
    })
    assert.deepEqual(result, { action: 'merge', priority: 4 })
})

test('own PR with new comments or reviews is respond, priority 4', () => {
    for (const kind of ['comments', 'reviews'] as const) {
        const result = computeAction({
            isOwn: true, isNew: false, snapshot: snap(), changes: [change(kind)],
        })
        assert.deepEqual(result, { action: 'respond', priority: 4 })
    }
})

test('own PR with only own pushes or nothing new is suppressed', () => {
    assert.equal(computeAction({ isOwn: true, isNew: false, snapshot: snap(), changes: [change('commits')] }), null)
    assert.equal(computeAction({ isOwn: true, isNew: true, snapshot: snap(), changes: [] }), null)
})

test('others new non-draft PR is review, priority 2', () => {
    const result = computeAction({ isOwn: false, isNew: true, snapshot: snap(), changes: [] })
    assert.deepEqual(result, { action: 'review', priority: 2 })
})

test('others PR becoming ready or re-requested is review', () => {
    for (const kind of ['ready', 're-requested'] as const) {
        const result = computeAction({
            isOwn: false, isNew: false, snapshot: snap(), changes: [change(kind)],
        })
        assert.deepEqual(result, { action: 'review', priority: 2 })
    }
})

test('others seen PR with new commits is re-review, priority 3', () => {
    const result = computeAction({
        isOwn: false, isNew: false, snapshot: snap(), changes: [change('commits')],
    })
    assert.deepEqual(result, { action: 're-review', priority: 3 })
})

test('others seen non-draft PR with only comments is update, priority 6', () => {
    const result = computeAction({
        isOwn: false, isNew: false, snapshot: snap(), changes: [change('comments')],
    })
    assert.deepEqual(result, { action: 'update', priority: 6 })
})

test('others new draft PR is architecture-check, priority 5', () => {
    const result = computeAction({
        isOwn: false, isNew: true, snapshot: snap({ isDraft: true }), changes: [],
    })
    assert.deepEqual(result, { action: 'architecture-check', priority: 5 })
})

test('others seen draft with changes is update; without changes suppressed', () => {
    const changed = computeAction({
        isOwn: false, isNew: false, snapshot: snap({ isDraft: true }), changes: [change('commits')],
    })
    assert.deepEqual(changed, { action: 'update', priority: 6 })
    assert.equal(
        computeAction({ isOwn: false, isNew: false, snapshot: snap({ isDraft: true }), changes: [] }),
        null
    )
})

test('unchanged seen PR is suppressed', () => {
    assert.equal(computeAction({ isOwn: false, isNew: false, snapshot: snap(), changes: [] }), null)
})

function item(overrides: Partial<TriageItem> = {}): TriageItem {
    return {
        key: 'safeinsights/management-app#1',
        repo: 'safeinsights/management-app',
        number: 1,
        title: 'Test PR',
        author: 'alice',
        url: 'https://github.com/safeinsights/management-app/pull/1',
        isOwn: false,
        isNew: true,
        action: 'review',
        priority: 2,
        changes: [],
        ...overrides,
    }
}

// Gap 1: the pending check used to run only on PRs that had already produced a
// review/re-review action, so a draft on an otherwise-quiet PR was never looked for.
// management-app#935 had two comments stranded this way since August 7th.
test('needsPendingCheck covers a quiet PR that produced no action', () => {
    assert.equal(needsPendingCheck({ isOwn: false, snapshot: snap() }), true)
})

test('needsPendingCheck skips my own PRs and drafts', () => {
    assert.equal(needsPendingCheck({ isOwn: true, snapshot: snap() }), false)
    assert.equal(needsPendingCheck({ isOwn: false, snapshot: snap({ isDraft: true }) }), false)
})

test('applyPendingReview promotes a null action into finish-pending', () => {
    assert.deepEqual(applyPendingReview(null), { action: 'finish-pending', priority: 2 })
})

test('applyPendingReview keeps a more urgent priority', () => {
    assert.deepEqual(applyPendingReview({ action: 'review', priority: 1 }), {
        action: 'finish-pending',
        priority: 1,
    })
    assert.deepEqual(applyPendingReview({ action: 'update', priority: 6 }), {
        action: 'finish-pending',
        priority: 2,
    })
})

// Gap 2: "Finish & submit your pending review" next to "you approved before this
// activity" read as a contradiction, which is what made the report look stale.
test('formatReport words a pending draft that sits beside a submitted review', () => {
    const report = formatReport(
        [item({ action: 'finish-pending', priority: 2, myReviewState: 'APPROVED', hasPendingReview: true })],
        { firstRun: false, errors: [] }
    )
    assert.match(report, /Finish & submit your pending review/)
    assert.match(report, /already approved this PR/)
    assert.match(report, /still unsubmitted/)
    assert.doesNotMatch(report, /you approved before this activity/)
})

test('formatReport words a pending draft with no submitted review', () => {
    const report = formatReport([item({ action: 'finish-pending', priority: 2, hasPendingReview: true })], {
        firstRun: false,
        errors: [],
    })
    assert.match(report, /only you can see it/)
})

test('formatReport keeps the plain reviewed note on non-pending actions', () => {
    const report = formatReport([item({ action: 'update', priority: 6, myReviewState: 'APPROVED' })], {
        firstRun: false,
        errors: [],
    })
    assert.match(report, /you approved before this activity/)
})

test('formatReport with no items reports all caught up', () => {
    assert.match(formatReport([], { firstRun: false, errors: [] }), /No new PR actions/)
})

test('formatReport sorts by priority and includes action, repo shortname, author', () => {
    const report = formatReport(
        [
            item({ number: 9, action: 'architecture-check', priority: 5, title: 'Draft thing' }),
            item({ number: 3, action: 'fix-ci', priority: 1, isOwn: true, author: 'nathan', title: 'My PR' }),
        ],
        { firstRun: false, errors: [] }
    )
    const fixIdx = report.indexOf('Fix CI')
    const archIdx = report.indexOf('Architecture check')
    assert.ok(fixIdx !== -1 && archIdx !== -1 && fixIdx < archIdx)
    assert.match(report, /management-app#3 "My PR" by you/)
    assert.match(report, /management-app#9 "Draft thing" by alice/)
})

test('formatReport includes what-changed line and url', () => {
    const report = formatReport(
        [item({ isNew: false, action: 're-review', priority: 3, changes: [
            { kind: 'commits', text: 'new commits' },
            { kind: 'comments', text: '2 new comments' },
        ] })],
        { firstRun: false, errors: [] }
    )
    assert.match(report, /changed: new commits, 2 new comments/)
    assert.match(report, /https:\/\/github.com\/safeinsights\/management-app\/pull\/1/)
})

test('formatReport notes first run and appends errors', () => {
    const report = formatReport([item()], {
        firstRun: true,
        errors: ['Failed to fetch PRs for safeinsights/encryption'],
    })
    assert.match(report, /First run/)
    assert.match(report, /WARNING: Failed to fetch PRs for safeinsights\/encryption/)
})

test('makeSnapshot records my latest non-pending review state', () => {
    const pr = rawPr({
        reviews: [
            { author: { login: 'nathan' }, state: 'COMMENTED', submittedAt: '2026-08-01T10:00:00Z' },
            { author: { login: 'nathan' }, state: 'APPROVED', submittedAt: '2026-08-02T10:00:00Z' },
            { author: { login: 'bob' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-08-03T10:00:00Z' },
            { author: { login: 'nathan' }, state: 'PENDING' },
        ],
    })
    assert.equal(makeSnapshot(pr, 'nathan', NOW).myReviewState, 'APPROVED')
})

test('makeSnapshot leaves myReviewState unset without my reviews', () => {
    const pr = rawPr({
        reviews: [{ author: { login: 'bob' }, state: 'APPROVED', submittedAt: '2026-08-01T10:00:00Z' }],
    })
    assert.equal(makeSnapshot(pr, 'nathan', NOW).myReviewState, undefined)
})

test('formatReport notes activity on an already-reviewed PR', () => {
    const report = formatReport(
        [item({ isNew: false, action: 're-review', priority: 3, myReviewState: 'APPROVED', changes: [
            { kind: 'commits', text: 'new commits' },
        ] })],
        { firstRun: false, errors: [] }
    )
    assert.match(report, /note: you approved before this activity/)
})

test('formatReport words the already-reviewed note by review state and omits it otherwise', () => {
    const changesRequested = formatReport(
        [item({ action: 'update', priority: 6, myReviewState: 'CHANGES_REQUESTED', changes: [
            { kind: 'comments', text: '1 new comment' },
        ] })],
        { firstRun: false, errors: [] }
    )
    assert.match(changesRequested, /note: you requested changes before this activity/)
    const plain = formatReport([item({ action: 'review' })], { firstRun: false, errors: [] })
    assert.ok(!plain.includes('note:'))
})

const CONFIGURED = ['safeinsights/management-app', 'safeinsights/iac']
const STALE_BEFORE = '2026-03-01T00:00:00Z'

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
    return {
        number: 30,
        repository: { nameWithOwner: 'safeinsights/openstax-research-image' },
        updatedAt: '2026-08-24T15:45:11Z',
        ...overrides,
    }
}

test('discoverRequestedRepos surfaces a repo missing from the config', () => {
    const found = discoverRequestedRepos([hit()], CONFIGURED, STALE_BEFORE)
    assert.deepEqual([...found.keys()], ['safeinsights/openstax-research-image'])
    assert.deepEqual([...found.get('safeinsights/openstax-research-image')!], [30])
})

test('discoverRequestedRepos ignores repos already configured', () => {
    const hits = [
        hit({ repository: { nameWithOwner: 'safeinsights/management-app' }, number: 980 }),
        hit({ repository: { nameWithOwner: 'safeinsights/iac' }, number: 177 }),
    ]
    assert.equal(discoverRequestedRepos(hits, CONFIGURED, STALE_BEFORE).size, 0)
})

// Two openstax PRs from 2018 still carry an open request; without the cutoff they
// would surface as "new" and then live in state.json forever.
test('discoverRequestedRepos drops requests older than the staleness cutoff', () => {
    const hits = [
        hit({ repository: { nameWithOwner: 'openstax/unicorn-spikes' }, number: 1, updatedAt: '2018-10-02T20:56:09Z' }),
        hit(),
    ]
    const found = discoverRequestedRepos(hits, CONFIGURED, STALE_BEFORE)
    assert.deepEqual([...found.keys()], ['safeinsights/openstax-research-image'])
})

test('discoverRequestedRepos groups several PRs in one discovered repo', () => {
    const hits = [hit({ number: 30 }), hit({ number: 31 })]
    const found = discoverRequestedRepos(hits, CONFIGURED, STALE_BEFORE)
    assert.deepEqual([...found.get('safeinsights/openstax-research-image')!].sort(), [30, 31])
})

test('discoverRequestedRepos tolerates a hit with no repository', () => {
    const hits = [{ number: 5, updatedAt: '2026-08-01T00:00:00Z' } as SearchHit, hit()]
    const found = discoverRequestedRepos(hits, CONFIGURED, STALE_BEFORE)
    assert.deepEqual([...found.keys()], ['safeinsights/openstax-research-image'])
})
