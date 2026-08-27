import { BOT_AUTHOR_RE } from './stats-lib.ts'

export function prKey(repo: string, number: number): string {
    return `${repo}#${number}`
}

export interface RawPr {
    number: number
    title: string
    url: string
    author: { login: string } | null
    isDraft: boolean
    headRefOid: string
    reviewDecision: string
    reviewRequests: Array<{ login?: string }>
    comments: Array<{ author?: { login?: string } }>
    reviews: Array<{ author?: { login?: string }; state?: string; submittedAt?: string }>
    statusCheckRollup: Array<{ conclusion?: string; state?: string }> | null
}

export interface Snapshot {
    headSha: string
    isDraft: boolean
    commentCount: number
    reviewCount: number
    /**
     * Counts excluding my own activity, and excluding bots for comments. The plain
     * counts include both, so they move when I comment or review — reporting my own
     * actions back to me — and when a coverage bot posts, which is never news.
     */
    othersCommentCount: number
    othersReviewCount: number
    reviewDecision: string
    reviewRequestedFromMe: boolean
    ciFailing: boolean
    myReviewState?: string
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
    /** Compare view spanning just what changed since the last report, when there is one. */
    url?: string
}

export type ActionKind =
    | 'fix-ci' | 'review' | 'finish-pending' | 're-review'
    | 'respond' | 'merge' | 'architecture-check' | 'update'

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
    myReviewState?: string
    /** Set when a pending draft of mine sits on the current head. */
    hasPendingReview?: boolean
}

export interface SearchHit {
    number: number
    repository: { nameWithOwner: string }
    updatedAt: string
}

/**
 * Repos holding a PR that asks for my review but that `config.json` never lists.
 *
 * The configured list is the set of repos worth watching wholesale; a review request
 * is a direct ask and can land anywhere, including a repo I touch once a year
 * (openstax-research-image#30 was missed exactly this way). Searching
 * `review-requested:@me` across all of GitHub finds those, and the repos it turns up
 * are then walked by the same `pr list` path as the configured ones, so a discovered
 * PR gets identical change tracking rather than a second, thinner code path.
 *
 * The PR numbers come back with the repo because a discovered repo is *not* watched
 * wholesale: only the PRs listed here are reported from it. Discovery says "this one
 * PR wants me", which is no reason to start reporting every unrelated PR in a repo I
 * was never watching.
 *
 * `staleBefore` drops long-abandoned requests. Two openstax PRs from 2018 still carry
 * an open request for me; surfacing them as "new" would be noise on the first run and
 * would then sit in state.json forever. Anything genuinely active updates well inside
 * the window.
 */
export function discoverRequestedRepos(
    hits: SearchHit[],
    configuredRepos: string[],
    staleBefore: string
): Map<string, Set<number>> {
    const configured = new Set(configuredRepos)
    const found = new Map<string, Set<number>>()
    for (const hit of hits) {
        const repo = hit.repository?.nameWithOwner
        if (!repo || configured.has(repo)) continue
        if (hit.updatedAt && hit.updatedAt < staleBefore) continue
        const numbers = found.get(repo) ?? new Set<number>()
        numbers.add(hit.number)
        found.set(repo, numbers)
    }
    return found
}

function hasFailingChecks(pr: RawPr): boolean {
    return (pr.statusCheckRollup ?? []).some(
        (c) => c.conclusion === 'FAILURE' || c.state === 'FAILURE' || c.state === 'ERROR'
    )
}

function latestOwnReviewState(pr: RawPr, login: string): string | undefined {
    const mine = (pr.reviews ?? [])
        .filter((r) => r.author?.login === login && r.state !== 'PENDING' && r.submittedAt)
        .sort((a, b) => (a.submittedAt as string).localeCompare(b.submittedAt as string))
    return mine.length > 0 ? mine[mine.length - 1].state : undefined
}

export function makeSnapshot(pr: RawPr, login: string, now: string): Snapshot {
    const isOwn = pr.author?.login === login
    const comments = pr.comments ?? []
    const reviews = pr.reviews ?? []
    return {
        headSha: pr.headRefOid,
        isDraft: pr.isDraft,
        commentCount: comments.length,
        reviewCount: reviews.length,
        othersCommentCount: comments.filter(
            (c) => c.author?.login !== login && !BOT_AUTHOR_RE.test(c.author?.login ?? '')
        ).length,
        othersReviewCount: reviews.filter((r) => r.author?.login !== login).length,
        reviewDecision: pr.reviewDecision ?? '',
        reviewRequestedFromMe: (pr.reviewRequests ?? []).some((r) => r.login === login),
        ciFailing: isOwn && hasFailingChecks(pr),
        myReviewState: latestOwnReviewState(pr, login),
        surfacedAt: now,
    }
}

const plural = (n: number, word: string) => `${n} new ${word}${n === 1 ? '' : 's'}`

/**
 * Compare view spanning only the commits pushed since the last report, rather than
 * the PR's whole diff — the point is to see what is new, not to re-read the PR.
 *
 * Force-pushes are the reason this can come back empty: if the old sha is no longer
 * an ancestor, GitHub renders a diverged comparison rather than a clean commit list.
 * The link still resolves, so it is left in place; the PR url on the next line is
 * always there as the fallback.
 */
function compareUrl(repo: string | undefined, from: string, to: string): string | undefined {
    if (!repo || !from || !to || from === to) return undefined
    return `https://github.com/${repo}/compare/${from.slice(0, 12)}...${to.slice(0, 12)}`
}

function othersOrTotal(snap: Snapshot, kind: 'comment' | 'review'): number {
    const others = kind === 'comment' ? snap.othersCommentCount : snap.othersReviewCount
    return others ?? (kind === 'comment' ? snap.commentCount : snap.reviewCount)
}

// Only ever counts other people's comments and reviews. My own approval landing on
// someone else's PR is not news to me, and on my own PR a self-reply is not either.
// Snapshots written before these fields existed fall back to the plain counts, which
// reproduces the old behaviour for one run rather than reporting a bogus delta.
export function describeChanges(prev: Snapshot, curr: Snapshot, repo?: string): Change[] {
    const changes: Change[] = []
    if (curr.headSha !== prev.headSha) {
        const url = compareUrl(repo, prev.headSha, curr.headSha)
        // Spread rather than an explicit `url: undefined`, so a change with no compare
        // view has no url key at all and stays deep-equal to a plain change object.
        changes.push({ kind: 'commits', text: 'new commits', ...(url ? { url } : {}) })
    }
    const newComments = othersOrTotal(curr, 'comment') - othersOrTotal(prev, 'comment')
    if (newComments > 0) changes.push({ kind: 'comments', text: plural(newComments, 'comment') })
    const newReviews = othersOrTotal(curr, 'review') - othersOrTotal(prev, 'review')
    if (newReviews > 0) changes.push({ kind: 'reviews', text: plural(newReviews, 'review') })
    if (prev.isDraft && !curr.isDraft) changes.push({ kind: 'ready', text: 'now ready for review' })
    if (!prev.isDraft && curr.isDraft) changes.push({ kind: 'draft', text: 'converted to draft' })
    if (!prev.reviewRequestedFromMe && curr.reviewRequestedFromMe)
        changes.push({ kind: 're-requested', text: 'review requested from you' })
    // A decision that flipped to match the review I just submitted is my own doing.
    // Left in when it disagrees with my review, since someone else moved it.
    const decisionIsMine =
        curr.myReviewState !== prev.myReviewState && curr.reviewDecision === curr.myReviewState
    if (curr.reviewDecision !== prev.reviewDecision && curr.reviewDecision && !decisionIsMine)
        changes.push({
            kind: 'decision',
            text: `review decision now ${curr.reviewDecision.toLowerCase().replaceAll('_', ' ')}`,
        })
    if (!prev.ciFailing && curr.ciFailing) changes.push({ kind: 'ci-failing', text: 'CI now failing' })
    return changes
}

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

/**
 * Whether a PR is worth spending a REST call on to look for an unsubmitted draft.
 *
 * Gap 1: this used to be gated on the PR already having produced a review/re-review
 * action, so a draft on a PR with no other activity was never looked for and sat
 * invisible indefinitely (management-app#935 had two comments stranded this way).
 *
 * Every open PR of someone else's is a candidate, whether or not it produced an
 * action, because a draft is exactly the thing that leaves no trace in the counts.
 * My own PRs are excluded: a draft review on my own PR is not a thing I can submit
 * meaningfully, and it keeps the call count to reviewable PRs only.
 */
export function needsPendingCheck(args: { isOwn: boolean; snapshot: Snapshot }): boolean {
    return !args.isOwn && !args.snapshot.isDraft
}

/**
 * Folds a discovered pending draft into an action.
 *
 * Gap 2: a draft is reported even when a submitted review already exists, since the
 * draft is real and unsubmitted either way — suppressing it would bury the comments.
 * What changes is the wording, so "you approved" and "you have a draft" stop reading
 * as a contradiction. `null` in means the PR produced no action of its own, which is
 * the case Gap 1 was dropping.
 */
export function applyPendingReview(
    result: { action: ActionKind; priority: number } | null
): { action: ActionKind; priority: number } {
    // Priority 2 alongside 'review': an unsubmitted draft is work already started.
    return { action: 'finish-pending', priority: Math.min(result?.priority ?? 2, 2) }
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

const REVIEWED_NOTES: Record<string, string> = {
    APPROVED: 'you approved before this activity',
    CHANGES_REQUESTED: 'you requested changes before this activity',
    COMMENTED: 'you reviewed (commented) before this activity',
}

// Gap 2: a draft sitting next to a review I already submitted is not a contradiction,
// but "Finish & submit your pending review" + "you approved" reads like one. Naming
// the submitted review in the same line resolves it without hiding the draft.
const SUPERSEDED_NOTES: Record<string, string> = {
    APPROVED: 'you have already approved this PR — the draft is separate and still unsubmitted',
    CHANGES_REQUESTED:
        'you have already requested changes on this PR — the draft is separate and still unsubmitted',
    COMMENTED: 'you have already submitted a review here — the draft is separate and still unsubmitted',
}

function noteFor(it: TriageItem): string | undefined {
    if (it.isOwn) return undefined
    if (it.action === 'finish-pending') {
        return SUPERSEDED_NOTES[it.myReviewState ?? ''] ?? 'the draft is not submitted yet, so only you can see it'
    }
    return REVIEWED_NOTES[it.myReviewState ?? '']
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
            // Its own line rather than inline in the summary: the compare url is long
            // enough to wrap, which would break up the change list mid-phrase.
            const diff = it.changes.find((c) => c.url)?.url
            if (diff) lines.push(`   diff since last seen: ${diff}`)
            const note = noteFor(it)
            if (note) lines.push(`   note: ${note}`)
            lines.push(`   ${it.url}`)
        })
    }
    for (const err of opts.errors) lines.push('', `WARNING: ${err}`)
    return lines.join('\n')
}
