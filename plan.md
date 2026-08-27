# pr-triage Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/pr-triage` skill that scripts the entire PR-triage pipeline (fetch → diff-against-state → prioritized report → mark seen) across the SafeInsights repos, surfacing only new actions.

**Architecture:** A zero-dependency TypeScript CLI (`scripts/triage.ts`) run by node's native type stripping. Pure logic (snapshots, diffing, action rules, report formatting) lives in `scripts/lib.ts` and is unit-tested with `node:test`; the CLI shell handles `gh` subprocess calls and state file IO. A thin SKILL.md tells Claude to run the script, relay the report verbatim, and chain into follow-up skills on the user's picks.

**Tech Stack:** TypeScript on node ≥ 23.6 native type stripping (v25 installed), `node:test` + `node:assert`, `gh` CLI for all GitHub access, pnpm as script runner only.

**Design doc:** `~/code/si/.claude/skills/pr-triage/design.md` — read it before starting.

## Global Constraints

- All files live in `~/code/si/.claude/skills/pr-triage/` — expand `~` to `/Users/nas`.
- **No git repo here.** `~/code/si` is not a git repository; all "commit" steps are intentionally omitted. Do not `git init`.
- Zero runtime dependencies. No `pnpm install`, no `node_modules`, no lockfile. The skill dir's `pnpm-workspace.yaml` (`lockfile: false`, `verifyDepsBeforeRun: false`) is what keeps pnpm v11 from materializing `node_modules`/`pnpm-lock.yaml` on `pnpm run` — do not remove it.
- Node native TS only supports *erasable* syntax: no `enum`, no `namespace`, no parameter properties. Use string-literal union types.
- Relative imports between TS files MUST include the `.ts` extension (`import ... from './lib.ts'`) — bare `./lib` fails under type stripping.
- The script must never write to GitHub — `gh` is used only for reads (`gh pr list`, `gh api user`, `gh api .../reviews` GETs).
- State updates must be atomic: write `state.json.tmp` then rename.
- A repo whose fetch fails must keep its previously-saved state entries untouched.

---

### Task 1: Package scaffold

**Files:**
- Create: `~/code/si/.claude/skills/pr-triage/package.json`
- Create: `~/code/si/.claude/skills/pr-triage/config.json`
- Create: `~/code/si/.claude/skills/pr-triage/scripts/lib.ts` (stub)
- Create: `~/code/si/.claude/skills/pr-triage/scripts/lib.test.ts` (smoke test)

**Interfaces:**
- Consumes: nothing.
- Produces: `pnpm --dir ~/code/si/.claude/skills/pr-triage test` runs `node --test`; `config.json` shape `{ "repos": string[] }`; `prKey(repo: string, number: number): string` in `lib.ts`.

- [ ] **Step 1: Write package.json**

```json
{
    "name": "pr-triage",
    "private": true,
    "type": "module",
    "scripts": {
        "triage": "node scripts/triage.ts",
        "stats": "node scripts/stats.ts",
        "test": "node --test scripts/lib.test.ts"
    }
}
```

- [ ] **Step 1b: Write pnpm-workspace.yaml** (keeps pnpm v11 from creating `node_modules`/lockfile on `pnpm run`)

```yaml
lockfile: false
verifyDepsBeforeRun: false
```

- [ ] **Step 2: Write config.json** (seeded from the `responsible repos` list in `~/code/si/info.yaml`; leave `info.yaml` untouched)

```json
{
    "repos": [
        "safeinsights/management-app",
        "safeinsights/encryption",
        "safeinsights/qa-review"
    ]
}
```

- [ ] **Step 3: Write the smoke test in `scripts/lib.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prKey } from './lib.ts'

test('prKey formats repo#number', () => {
    assert.equal(prKey('safeinsights/management-app', 123), 'safeinsights/management-app#123')
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage test`
Expected: FAIL — cannot find module `./lib.ts`.

- [ ] **Step 5: Write the stub `scripts/lib.ts`**

```ts
export function prKey(repo: string, number: number): string {
    return `${repo}#${number}`
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage test`
Expected: PASS (1 test).

---

### Task 2: Snapshot creation and change detection (`lib.ts`)

**Files:**
- Modify: `~/code/si/.claude/skills/pr-triage/scripts/lib.ts`
- Test: `~/code/si/.claude/skills/pr-triage/scripts/lib.test.ts`

**Interfaces:**
- Consumes: `prKey` from Task 1.
- Produces (exact exports later tasks rely on):

```ts
export interface RawPr {           // subset of `gh pr list --json` output
    number: number
    title: string
    url: string
    author: { login: string }
    isDraft: boolean
    headRefOid: string
    reviewDecision: string          // '', 'APPROVED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED'
    reviewRequests: Array<{ login?: string }>
    comments: Array<{ author?: { login?: string } }>
    reviews: Array<{ author?: { login?: string }; state?: string }>
    statusCheckRollup: Array<{ conclusion?: string; state?: string }> | null
}

export interface Snapshot {
    headSha: string
    isDraft: boolean
    commentCount: number
    reviewCount: number
    reviewDecision: string
    reviewRequestedFromMe: boolean
    ciFailing: boolean              // only ever true on the user's own PRs
    surfacedAt: string
}

export interface State {
    login?: string
    prs: Record<string, Snapshot>   // keyed by prKey()
}

export type ChangeKind =
    | 'commits' | 'comments' | 'reviews' | 'ready' | 'draft'
    | 're-requested' | 'decision' | 'ci-failing'

export interface Change {
    kind: ChangeKind
    text: string
}

export function makeSnapshot(pr: RawPr, login: string, now: string): Snapshot
export function describeChanges(prev: Snapshot, curr: Snapshot): Change[]
```

- [ ] **Step 1: Write failing tests.** Append to `scripts/lib.test.ts`:

```ts
import { makeSnapshot, describeChanges, type RawPr, type Snapshot } from './lib.ts'

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

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
    return {
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
}

test('describeChanges returns empty for identical snapshots', () => {
    assert.deepEqual(describeChanges(snap(), snap()), [])
})

test('describeChanges reports new commits', () => {
    const changes = describeChanges(snap(), snap({ headSha: 'bbb222' }))
    assert.deepEqual(changes, [{ kind: 'commits', text: 'new commits' }])
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

test('describeChanges reports CI newly failing but not recovery', () => {
    assert.deepEqual(describeChanges(snap(), snap({ ciFailing: true })), [
        { kind: 'ci-failing', text: 'CI now failing' },
    ])
    assert.deepEqual(describeChanges(snap({ ciFailing: true }), snap()), [])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage test`
Expected: FAIL — `makeSnapshot`/`describeChanges` not exported.

- [ ] **Step 3: Implement in `scripts/lib.ts`** (add below `prKey`):

```ts
export interface RawPr {
    number: number
    title: string
    url: string
    author: { login: string }
    isDraft: boolean
    headRefOid: string
    reviewDecision: string
    reviewRequests: Array<{ login?: string }>
    comments: Array<{ author?: { login?: string } }>
    reviews: Array<{ author?: { login?: string }; state?: string }>
    statusCheckRollup: Array<{ conclusion?: string; state?: string }> | null
}

export interface Snapshot {
    headSha: string
    isDraft: boolean
    commentCount: number
    reviewCount: number
    reviewDecision: string
    reviewRequestedFromMe: boolean
    ciFailing: boolean
    surfacedAt: string
}

export interface State {
    login?: string
    prs: Record<string, Snapshot>
}

export type ChangeKind =
    | 'commits' | 'comments' | 'reviews' | 'ready' | 'draft'
    | 're-requested' | 'decision' | 'ci-failing'

export interface Change {
    kind: ChangeKind
    text: string
}

function hasFailingChecks(pr: RawPr): boolean {
    return (pr.statusCheckRollup ?? []).some(
        (c) => c.conclusion === 'FAILURE' || c.state === 'FAILURE' || c.state === 'ERROR'
    )
}

export function makeSnapshot(pr: RawPr, login: string, now: string): Snapshot {
    const isOwn = pr.author.login === login
    return {
        headSha: pr.headRefOid,
        isDraft: pr.isDraft,
        commentCount: pr.comments?.length ?? 0,
        reviewCount: pr.reviews?.length ?? 0,
        reviewDecision: pr.reviewDecision ?? '',
        reviewRequestedFromMe: (pr.reviewRequests ?? []).some((r) => r.login === login),
        ciFailing: isOwn && hasFailingChecks(pr),
        surfacedAt: now,
    }
}

const plural = (n: number, word: string) => `${n} new ${word}${n === 1 ? '' : 's'}`

export function describeChanges(prev: Snapshot, curr: Snapshot): Change[] {
    const changes: Change[] = []
    if (curr.headSha !== prev.headSha) changes.push({ kind: 'commits', text: 'new commits' })
    const newComments = curr.commentCount - prev.commentCount
    if (newComments > 0) changes.push({ kind: 'comments', text: plural(newComments, 'comment') })
    const newReviews = curr.reviewCount - prev.reviewCount
    if (newReviews > 0) changes.push({ kind: 'reviews', text: plural(newReviews, 'review') })
    if (prev.isDraft && !curr.isDraft) changes.push({ kind: 'ready', text: 'now ready for review' })
    if (!prev.isDraft && curr.isDraft) changes.push({ kind: 'draft', text: 'converted to draft' })
    if (!prev.reviewRequestedFromMe && curr.reviewRequestedFromMe)
        changes.push({ kind: 're-requested', text: 'review requested from you' })
    if (curr.reviewDecision !== prev.reviewDecision && curr.reviewDecision)
        changes.push({
            kind: 'decision',
            text: `review decision now ${curr.reviewDecision.toLowerCase().replaceAll('_', ' ')}`,
        })
    if (!prev.ciFailing && curr.ciFailing) changes.push({ kind: 'ci-failing', text: 'CI now failing' })
    return changes
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage test`
Expected: PASS (all tests).

---

### Task 3: Action rules (`lib.ts`)

**Files:**
- Modify: `~/code/si/.claude/skills/pr-triage/scripts/lib.ts`
- Test: `~/code/si/.claude/skills/pr-triage/scripts/lib.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `Change` from Task 2.
- Produces:

```ts
export type ActionKind =
    | 'fix-ci' | 'review' | 'finish-pending' | 're-review'
    | 'respond' | 'merge' | 'architecture-check' | 'update'

// Returns null when the PR should be silently absorbed into state without surfacing
// (unchanged PRs, the user's own pushes, the user's own brand-new PRs with green CI).
export function computeAction(args: {
    isOwn: boolean
    isNew: boolean
    snapshot: Snapshot
    changes: Change[]
}): { action: ActionKind; priority: number } | null
```

Priorities (lower = more urgent, drives report sort): fix-ci 1, review 2, re-review 3, respond/merge 4, architecture-check 5, update 6. `finish-pending` is assigned later by the CLI (Task 5) by downgrading a `review`/`re-review` item, so it keeps that item's priority.

- [ ] **Step 1: Write failing tests.** Append to `scripts/lib.test.ts` (reuses `snap()` helper from Task 2; a `change(kind)` helper builds minimal `Change` objects):

```ts
import { computeAction, type Change, type ChangeKind } from './lib.ts'

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage test`
Expected: FAIL — `computeAction` not exported.

- [ ] **Step 3: Implement in `scripts/lib.ts`:**

```ts
export type ActionKind =
    | 'fix-ci' | 'review' | 'finish-pending' | 're-review'
    | 'respond' | 'merge' | 'architecture-check' | 'update'

const has = (changes: Change[], kind: ChangeKind) => changes.some((c) => c.kind === kind)

export function computeAction(args: {
    isOwn: boolean
    isNew: boolean
    snapshot: Snapshot
    changes: Change[]
}): { action: ActionKind; priority: number } | null {
    const { isOwn, isNew, snapshot, changes } = args
    if (isOwn) {
        if (has(changes, 'ci-failing') || (isNew && snapshot.ciFailing))
            return { action: 'fix-ci', priority: 1 }
        if (has(changes, 'decision') && snapshot.reviewDecision === 'APPROVED')
            return { action: 'merge', priority: 4 }
        if (has(changes, 'comments') || has(changes, 'reviews'))
            return { action: 'respond', priority: 4 }
        return null
    }
    if (!snapshot.isDraft) {
        if (isNew || has(changes, 'ready') || has(changes, 're-requested'))
            return { action: 'review', priority: 2 }
        if (has(changes, 'commits')) return { action: 're-review', priority: 3 }
        if (changes.length > 0) return { action: 'update', priority: 6 }
        return null
    }
    if (isNew) return { action: 'architecture-check', priority: 5 }
    if (changes.length > 0) return { action: 'update', priority: 6 }
    return null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage test`
Expected: PASS (all tests).

---

### Task 4: Report formatting (`lib.ts`)

**Files:**
- Modify: `~/code/si/.claude/skills/pr-triage/scripts/lib.ts`
- Test: `~/code/si/.claude/skills/pr-triage/scripts/lib.test.ts`

**Interfaces:**
- Consumes: `ActionKind`, `Change` from Tasks 2–3.
- Produces:

```ts
export interface TriageItem {
    key: string            // prKey()
    repo: string           // 'owner/name'
    number: number
    title: string
    author: string
    url: string
    isOwn: boolean
    isNew: boolean
    action: ActionKind
    priority: number
    changes: Change[]
}

export function formatReport(
    items: TriageItem[],
    opts: { firstRun: boolean; errors: string[] }
): string
```

- [ ] **Step 1: Write failing tests.** Append to `scripts/lib.test.ts`:

```ts
import { formatReport, type TriageItem } from './lib.ts'

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage test`
Expected: FAIL — `formatReport` not exported.

- [ ] **Step 3: Implement in `scripts/lib.ts`:**

```ts
export interface TriageItem {
    key: string
    repo: string
    number: number
    title: string
    author: string
    url: string
    isOwn: boolean
    isNew: boolean
    action: ActionKind
    priority: number
    changes: Change[]
}

const ACTION_LABELS: Record<ActionKind, string> = {
    'fix-ci': 'Fix CI',
    review: 'Review',
    'finish-pending': 'Finish & submit your pending review',
    're-review': 'Re-review',
    respond: 'Respond',
    merge: 'Approved — merge?',
    'architecture-check': 'Architecture check',
    update: 'Updated (FYI)',
}

export function formatReport(
    items: TriageItem[],
    opts: { firstRun: boolean; errors: string[] }
): string {
    const lines: string[] = []
    if (opts.firstRun) lines.push('First run — no prior state, so every open PR surfaces as new.', '')
    if (items.length === 0) {
        lines.push('No new PR actions. All caught up.')
    } else {
        lines.push(`${items.length} PR action${items.length === 1 ? '' : 's'}:`, '')
        const sorted = [...items].sort(
            (a, b) => a.priority - b.priority || a.repo.localeCompare(b.repo) || a.number - b.number
        )
        sorted.forEach((it, i) => {
            const shortRepo = it.repo.split('/')[1] ?? it.repo
            const who = it.isOwn ? 'you' : it.author
            lines.push(`${i + 1}. ${ACTION_LABELS[it.action]} — ${shortRepo}#${it.number} "${it.title}" by ${who}`)
            if (it.changes.length > 0) lines.push(`   changed: ${it.changes.map((c) => c.text).join(', ')}`)
            lines.push(`   ${it.url}`)
        })
    }
    for (const err of opts.errors) lines.push('', `WARNING: ${err}`)
    return lines.join('\n')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage test`
Expected: PASS (all tests).

---

### Task 5: CLI orchestration (`triage.ts`)

**Files:**
- Create: `~/code/si/.claude/skills/pr-triage/scripts/triage.ts`

**Interfaces:**
- Consumes: everything exported from `lib.ts` (Tasks 1–4).
- Produces: the `pnpm triage` entrypoint with `--dry-run` and `--json` flags; `state.json` in the skill root.

This file is deliberately thin glue around tested logic — it is verified by live `--dry-run` runs rather than unit tests (mocking `gh` would violate the "test real behavior" principle for no gain; all decision logic is already unit-tested).

- [ ] **Step 1: Write `scripts/triage.ts`:**

```ts
#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    computeAction, describeChanges, formatReport, makeSnapshot, prKey,
    type Change, type RawPr, type Snapshot, type State, type TriageItem,
} from './lib.ts'

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_PATH = join(SKILL_DIR, 'config.json')
const STATE_PATH = join(SKILL_DIR, 'state.json')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const asJson = argv.includes('--json')

const PR_FIELDS =
    'number,title,author,isDraft,headRefOid,url,reviewDecision,reviewRequests,comments,reviews,statusCheckRollup'

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

const { repos } = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { repos: string[] }
const { state, firstRun } = loadState()
const login = state.login ?? gh('api', 'user', '-q', '.login').trim()
const now = new Date().toISOString()

const errors: string[] = []
const items: TriageItem[] = []
const nextPrs: Record<string, Snapshot> = {}

for (const repo of repos) {
    let prs: RawPr[]
    try {
        prs = JSON.parse(gh('pr', 'list', '--repo', repo, '--state', 'open', '--json', PR_FIELDS))
    } catch (err) {
        errors.push(`Failed to fetch PRs for ${repo}: ${(err as Error).message.split('\n')[0]} — its saved state is untouched.`)
        for (const [key, snapshot] of Object.entries(state.prs)) {
            if (key.startsWith(`${repo}#`)) nextPrs[key] = snapshot
        }
        continue
    }
    for (const pr of prs) {
        const key = prKey(repo, pr.number)
        const prev = state.prs[key]
        const snapshot = makeSnapshot(pr, login, now)
        const isOwn = pr.author.login === login
        const isNew = prev === undefined
        const changes: Change[] = prev ? describeChanges(prev, snapshot) : []
        const result = computeAction({ isOwn, isNew, snapshot, changes })
        if (result) {
            items.push({
                key, repo,
                number: pr.number, title: pr.title, author: pr.author.login, url: pr.url,
                isOwn, isNew, changes, ...result,
            })
        } else if (prev) {
            snapshot.surfacedAt = prev.surfacedAt
        }
        nextPrs[key] = snapshot
    }
}

for (const item of items) {
    if (item.action !== 'review' && item.action !== 're-review') continue
    try {
        const reviews = JSON.parse(gh('api', `repos/${item.repo}/pulls/${item.number}/reviews`)) as Array<{
            state: string
            user: { login: string } | null
        }>
        if (reviews.some((r) => r.state === 'PENDING' && r.user?.login === login)) {
            item.action = 'finish-pending'
        }
    } catch {
        errors.push(`Could not check for a pending review on ${item.key}; showing the plain action.`)
    }
}

if (asJson) {
    console.log(JSON.stringify({ firstRun, items, errors }, null, 2))
} else {
    console.log(formatReport(items, { firstRun, errors }))
}

if (dryRun) {
    console.log('\n(dry run — nothing marked as seen)')
} else {
    const next: State = { login, prs: nextPrs }
    writeFileSync(STATE_PATH + '.tmp', JSON.stringify(next, null, 2) + '\n')
    renameSync(STATE_PATH + '.tmp', STATE_PATH)
}
```

- [ ] **Step 2: Verify types still check and unit tests pass**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage test`
Expected: PASS. (Type stripping doesn't type-check; a syntax error in `triage.ts` would surface in Step 3.)

- [ ] **Step 3: Live dry run**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage triage --dry-run`
Expected: "First run" note, every open PR across the three repos listed with an action, `(dry run — nothing marked as seen)` footer, and NO `state.json` created. Sanity-check a few lines against `gh pr list --repo safeinsights/management-app` output.

- [ ] **Step 4: Verify dry run is idempotent**

Run the same command again. Expected: identical output (state was never written).

- [ ] **Step 5: Real run + suppression check**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage triage`
Expected: same report, then `state.json` exists and contains a snapshot per open PR plus `"login"`.

Run it a second time. Expected: `No new PR actions. All caught up.` — this is the core memory behavior working.

- [ ] **Step 6: Verify --json mode**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage triage --dry-run --json`
Expected: valid JSON with `firstRun: false`, `items: []` (everything now seen), `errors: []`.

---

### Task 6: Stats computation (`stats-lib.ts`)

**Files:**
- Create: `~/code/si/.claude/skills/pr-triage/scripts/stats-lib.ts`
- Create: `~/code/si/.claude/skills/pr-triage/scripts/stats-lib.test.ts`
- Modify: `~/code/si/.claude/skills/pr-triage/package.json` (extend the `test` script)

**Interfaces:**
- Consumes: nothing from `lib.ts` — stats are fully independent of triage.
- Produces (exact exports Task 7 relies on):

```ts
export interface HistoryReview { author?: string; state?: string; submittedAt?: string }
export interface HistoryComment { author?: string; createdAt?: string }
export interface HistoryCommit { committedDate?: string }

export interface HistoryPr {
    author: string
    createdAt: string
    mergedAt: string | null
    updatedAt: string
    reviews: HistoryReview[]
    comments: HistoryComment[]
    commits: HistoryCommit[]
}

export interface StatsHistory {
    fetchedAt: string
    coverageStart: string
    prs: Record<string, HistoryPr>   // keyed 'owner/repo#number'
}

export function median(values: number[]): number | null
export function hoursBetween(from: string, to: string): number
export function formatDuration(hours: number): string
// dev login -> hours-to-respond samples (review feedback -> author's next comment/commit)
export function responseTimes(prs: HistoryPr[], sinceIso: string): Record<string, number[]>
// dev login -> opened->merged duration samples (length of array = merged count)
export function velocity(prs: HistoryPr[], sinceIso: string): Record<string, number[]>
// hours from PR creation to `login`'s first submitted review, per reviewed PR
export function myReviewLatency(prs: HistoryPr[], login: string, sinceIso: string): number[]
export function formatStatsReport(args: {
    days: number
    responses: Record<string, number[]>
    velocities: Record<string, number[]>
    myLatencies: number[]
}): string
```

All timestamp comparisons are plain string comparisons — GitHub returns ISO-8601 UTC (`...Z`) throughout, which sorts lexicographically.

- [ ] **Step 1: Extend the `test` script in `package.json`:**

```json
"test": "node --test scripts/lib.test.ts scripts/stats-lib.test.ts"
```

- [ ] **Step 2: Write failing tests in `scripts/stats-lib.test.ts`:**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    formatDuration, formatStatsReport, hoursBetween, median,
    myReviewLatency, responseTimes, velocity, type HistoryPr,
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
    })
    assert.match(report, /last 30 days/)
    assert.match(report, /alice\s+4\.0h\s+\(n=3\)/)
    assert.match(report, /alice\s+2 merged, median 2\.5d/)
    assert.match(report, /median 9\.0h\s+\(n=2\)/)
})

test('formatStatsReport handles empty data', () => {
    const report = formatStatsReport({ days: 30, responses: {}, velocities: {}, myLatencies: [] })
    assert.match(report, /no samples/)
    assert.match(report, /no merged PRs/)
    assert.match(report, /no reviews in window/)
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage test`
Expected: FAIL — cannot find module `./stats-lib.ts`. (The Task 1–4 `lib.test.ts` tests must still pass.)

- [ ] **Step 4: Implement `scripts/stats-lib.ts`:**

```ts
export interface HistoryReview { author?: string; state?: string; submittedAt?: string }
export interface HistoryComment { author?: string; createdAt?: string }
export interface HistoryCommit { committedDate?: string }

export interface HistoryPr {
    author: string
    createdAt: string
    mergedAt: string | null
    updatedAt: string
    reviews: HistoryReview[]
    comments: HistoryComment[]
    commits: HistoryCommit[]
}

export interface StatsHistory {
    fetchedAt: string
    coverageStart: string
    prs: Record<string, HistoryPr>
}

export function median(values: number[]): number | null {
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function hoursBetween(from: string, to: string): number {
    return (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000
}

export function formatDuration(hours: number): string {
    if (hours < 1) return `${Math.round(hours * 60)}m`
    if (hours < 48) return `${hours.toFixed(1)}h`
    return `${(hours / 24).toFixed(1)}d`
}

const FEEDBACK_STATES = new Set(['CHANGES_REQUESTED', 'COMMENTED'])

export function responseTimes(prs: HistoryPr[], sinceIso: string): Record<string, number[]> {
    const byDev: Record<string, number[]> = {}
    for (const pr of prs) {
        for (const review of pr.reviews) {
            if (!review.submittedAt || review.submittedAt < sinceIso) continue
            if (review.author === pr.author) continue
            if (!FEEDBACK_STATES.has(review.state ?? '')) continue
            const candidates: string[] = []
            for (const comment of pr.comments) {
                if (comment.author === pr.author && comment.createdAt && comment.createdAt > review.submittedAt)
                    candidates.push(comment.createdAt)
            }
            for (const commit of pr.commits) {
                if (commit.committedDate && commit.committedDate > review.submittedAt)
                    candidates.push(commit.committedDate)
            }
            if (candidates.length === 0) continue
            candidates.sort()
            ;(byDev[pr.author] ??= []).push(hoursBetween(review.submittedAt, candidates[0]))
        }
    }
    return byDev
}

export function velocity(prs: HistoryPr[], sinceIso: string): Record<string, number[]> {
    const byDev: Record<string, number[]> = {}
    for (const pr of prs) {
        if (!pr.mergedAt || pr.mergedAt < sinceIso) continue
        ;(byDev[pr.author] ??= []).push(hoursBetween(pr.createdAt, pr.mergedAt))
    }
    return byDev
}

export function myReviewLatency(prs: HistoryPr[], login: string, sinceIso: string): number[] {
    const latencies: number[] = []
    for (const pr of prs) {
        if (pr.author === login || pr.createdAt < sinceIso) continue
        const mine = pr.reviews
            .filter((r) => r.author === login && r.submittedAt)
            .map((r) => r.submittedAt as string)
            .sort()
        if (mine.length === 0) continue
        latencies.push(hoursBetween(pr.createdAt, mine[0]))
    }
    return latencies
}

export function formatStatsReport(args: {
    days: number
    responses: Record<string, number[]>
    velocities: Record<string, number[]>
    myLatencies: number[]
}): string {
    const lines: string[] = [`PR stats — last ${args.days} days`, '']

    lines.push('Response to review feedback (median):')
    const responders = Object.keys(args.responses).sort()
    if (responders.length === 0) lines.push('  (no samples)')
    for (const dev of responders) {
        const samples = args.responses[dev]
        lines.push(`  ${dev.padEnd(16)} ${formatDuration(median(samples) as number)}  (n=${samples.length})`)
    }

    lines.push('', 'Velocity (merged PRs, opened→merged median):')
    const mergers = Object.keys(args.velocities).sort()
    if (mergers.length === 0) lines.push('  (no merged PRs)')
    for (const dev of mergers) {
        const durations = args.velocities[dev]
        lines.push(`  ${dev.padEnd(16)} ${durations.length} merged, median ${formatDuration(median(durations) as number)}`)
    }

    lines.push('', 'Your review latency (PR opened → your first review):')
    lines.push(
        args.myLatencies.length === 0
            ? '  (no reviews in window)'
            : `  median ${formatDuration(median(args.myLatencies) as number)}  (n=${args.myLatencies.length})`
    )
    return lines.join('\n')
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage test`
Expected: PASS (all `lib.test.ts` + `stats-lib.test.ts` tests).

---

### Task 7: Stats CLI with incremental history cache (`stats.ts`)

**Files:**
- Create: `~/code/si/.claude/skills/pr-triage/scripts/stats.ts`

**Interfaces:**
- Consumes: everything exported from `stats-lib.ts` (Task 6).
- Produces: the `pnpm stats` entrypoint with `--days N` (default 30) and `--json` flags; `stats-history.json` cache in the skill root.

Cache behavior (from the design doc): full fetch on first run; afterwards each run fetches only PRs updated since the previous run (with a 1-day overlap), merged over the stored entries. A `--days` value reaching further back than the cache's `coverageStart` forces a full refetch.

> **As-built deviation:** the single `gh pr list --limit 500` call below proved impossible against real repos — GitHub's GraphQL node budget rejects limits above ~48 with the reviews/comments/commits field set. The shipped `stats.ts` instead paginates manually (`fetchAllPages`, `PAGE_SIZE = 40`, `sort:updated-asc` cursor walk) with same-second-tie resolution via a bounded `MAX_SAFE_LIMIT = 48` re-fetch, a `+1s` cursor advance once a tied second is fully captured, a warning pushed to `errors[]` if >48 PRs share one second, and a 500-page-per-repo hard cap.

- [ ] **Step 1: Write `scripts/stats.ts`:**

```ts
#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    formatStatsReport, myReviewLatency, responseTimes, velocity,
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
    author: { login: string }
    createdAt: string
    mergedAt: string | null
    updatedAt: string
    reviews: Array<{ author?: { login?: string }; state?: string; submittedAt?: string }>
    comments: Array<{ author?: { login?: string }; createdAt?: string }>
    commits: Array<{ committedDate?: string }>
}

function trimPr(raw: RawHistoryPr): HistoryPr {
    return {
        author: raw.author.login,
        createdAt: raw.createdAt,
        mergedAt: raw.mergedAt,
        updatedAt: raw.updatedAt,
        reviews: (raw.reviews ?? []).map((r) => ({
            author: r.author?.login, state: r.state, submittedAt: r.submittedAt,
        })),
        comments: (raw.comments ?? []).map((c) => ({ author: c.author?.login, createdAt: c.createdAt })),
        commits: (raw.commits ?? []).map((c) => ({ committedDate: c.committedDate })),
    }
}

function loadHistory(): StatsHistory | null {
    if (!existsSync(HISTORY_PATH)) return null
    try {
        return JSON.parse(readFileSync(HISTORY_PATH, 'utf8')) as StatsHistory
    } catch {
        return null
    }
}

const STAT_FIELDS = 'number,author,createdAt,mergedAt,updatedAt,reviews,comments,commits'

const prior = loadHistory()
const fullRefetch = prior === null || windowStart < prior.coverageStart
const fetchSince = fullRefetch
    ? windowStart
    : new Date(new Date(prior.fetchedAt).getTime() - DAY_MS).toISOString()

const history: StatsHistory = fullRefetch
    ? { fetchedAt: now.toISOString(), coverageStart: windowStart, prs: {} }
    : { ...(prior as StatsHistory), fetchedAt: now.toISOString() }

const { repos } = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { repos: string[] }
const errors: string[] = []
for (const repo of repos) {
    try {
        const fetched = JSON.parse(
            gh('pr', 'list', '--repo', repo, '--state', 'all', '--limit', '500',
                '--search', `updated:>=${fetchSince.slice(0, 10)}`, '--json', STAT_FIELDS)
        ) as RawHistoryPr[]
        for (const raw of fetched) history.prs[`${repo}#${raw.number}`] = trimPr(raw)
    } catch (err) {
        errors.push(`Failed to fetch history for ${repo}: ${(err as Error).message.split('\n')[0]}`)
    }
}

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

if (asJson) {
    console.log(JSON.stringify({ days, responses, velocities, myLatencies, errors }, null, 2))
} else {
    console.log(formatStatsReport({ days, responses, velocities, myLatencies }))
    for (const err of errors) console.log(`\nWARNING: ${err}`)
}

writeFileSync(HISTORY_PATH + '.tmp', JSON.stringify(history, null, 2) + '\n')
renameSync(HISTORY_PATH + '.tmp', HISTORY_PATH)
```

- [ ] **Step 2: Run unit tests (still green)**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage test`
Expected: PASS.

- [ ] **Step 3: Live first run (full history fetch)**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage stats`
Expected: a three-section report; `stats-history.json` created with `fetchedAt`, `coverageStart` ≈ 30 days ago, and PR entries. Spot-check one dev's merged count against
`gh pr list --repo safeinsights/management-app --state merged --search "merged:>=<coverage-start-date>" --author <dev>`.

- [ ] **Step 4: Live second run (incremental)**

Run the same command again. Expected: noticeably faster (only recently-updated PRs fetched), same numbers, `fetchedAt` advanced in `stats-history.json`.

- [ ] **Step 5: Verify --days wider than coverage triggers a refetch**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage stats --days 60`
Expected: slower full refetch, `coverageStart` in `stats-history.json` moves back to ≈ 60 days ago, report header says "last 60 days".

- [ ] **Step 6: Verify --json**

Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage stats --json`
Expected: valid JSON with `days`, `responses`, `velocities`, `myLatencies`, `errors`.

---

### Task 8: SKILL.md, discovery check, and end-to-end

**Files:**
- Create: `~/code/si/.claude/skills/pr-triage/SKILL.md`
- Maybe create: `~/.claude/skills/pr-triage/SKILL.md` (shim, only if discovery fails)

**Interfaces:**
- Consumes: the `pnpm triage` entrypoint from Task 5 and the `pnpm stats` entrypoint from Task 7.
- Produces: the user-facing `/pr-triage` skill.

- [ ] **Step 1: Write `SKILL.md`:**

```markdown
---
name: pr-triage
description: Use when Nathan asks to triage PRs, "what PRs need my attention", "any new PRs?", or invokes /pr-triage. Surfaces only NEW actions (review, re-review, respond, fix CI, architecture-check drafts) across the SafeInsights repos, remembering what was already shown. Running it marks surfaced PRs as seen. Also covers team PR stats ("dev velocity", "response times", "how fast do I review").
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
   - **Finish & submit your pending review** → a PENDING review by Nathan already
     exists; per draft-pr-review's notes, append to it via GraphQL
     `addPullRequestReviewThread` or remind him to open the review URL and submit.
   - **Architecture check** → fetch the diff (`gh pr diff <n> --repo <repo>`) and
     give a broad structural overview: what the change does, design concerns,
     simplification opportunities. No GitHub writes.
   - **Respond** / **Fix CI** / **Approved — merge?** → these are Nathan's own PRs;
     help investigate as asked (e.g. `gh pr checks`, reading new comments).

## Stats

When Nathan asks for team PR stats (dev velocity, how fast devs respond to review
feedback, his own review latency):

1. Run: `pnpm --dir ~/code/si/.claude/skills/pr-triage stats`
   - `--days N` changes the window (default 30). `--json` for structured output.
2. Relay the report verbatim. Metrics are medians; `n=` is the sample count.
3. The first run fetches ~30 days of history and is slow; later runs update
   incrementally from `stats-history.json` and are fast.

## Notes

- Config (repo list): `config.json` next to this file.
- Triage memory: `state.json` next to this file — one snapshot per open PR.
  Deleting it resets memory (everything surfaces again). To "unsee" a single PR,
  delete just that PR's key.
- Stats cache: `stats-history.json` next to this file — deleting it forces a full
  history refetch on the next stats run; nothing else is lost.
- Neither script ever writes to GitHub.
```

- [ ] **Step 2: Verify skill discovery from a repo subdirectory**

Run: `cd ~/code/si/management-app && claude -p "Is a skill named pr-triage available to you? Reply only yes or no."`
Expected: `yes`.

- [ ] **Step 3 (only if Step 2 says no): Create the shim**

Write `~/.claude/skills/pr-triage/SKILL.md`:

```markdown
---
name: pr-triage
description: Use when Nathan asks to triage PRs, "what PRs need my attention", "any new PRs?", or invokes /pr-triage. Surfaces only NEW PR actions across the SafeInsights repos.
---

Read and follow `~/code/si/.claude/skills/pr-triage/SKILL.md`.
```

Re-run the Step 2 check; expected `yes`.

- [ ] **Step 4: End-to-end exercise**

Delete `~/code/si/.claude/skills/pr-triage/state.json`, then run the skill's step-1 command once (marks all seen), then again. Expected: first run lists all PRs, second prints `No new PR actions. All caught up.` Leave the resulting `state.json` in place — from this point Nathan's real usage continues from it.
```
