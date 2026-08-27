export interface HistoryReview { author?: string; state?: string; submittedAt?: string }
export interface HistoryComment { author?: string; createdAt?: string; chars?: number }
export interface HistoryCommit { committedDate?: string; messageChars?: number; hasAiMarker?: boolean }

export interface HistoryPr {
    author: string
    createdAt: string
    mergedAt: string | null
    updatedAt: string
    reviews: HistoryReview[]
    comments: HistoryComment[]
    commits: HistoryCommit[]
    bodyChars?: number
    bodyStructure?: number
    hasAiMarker?: boolean
}

export interface StatsHistory {
    version?: number
    fetchedAt: string
    coverageStart: string
    prs: Record<string, HistoryPr>
}

export interface AiBucket {
    bucketStart: string
    score: number
    prCount: number
    commentCount: number
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

export const AI_MARKER_RE =
    /co-authored-by:\s*(claude|.*copilot|cursor|devin|chatgpt|openai)|generated with (claude|\[?claude code|copilot|cursor)|🤖/i

export const BOT_AUTHOR_RE = /^app\/|\[bot\]$|^(dependabot|github-actions|renovate)$/i

export function hasAiMarkerText(text: string): boolean {
    return AI_MARKER_RE.test(text)
}

export function countMarkdownStructure(text: string): number {
    const headerRe = /^#{1,6}\s/m
    const bulletRe = /^\s*[-*+]\s/m
    const numberRe = /^\s*\d+\.\s/m
    const tableRe = /^\s*\|/m

    const lines = text.split('\n')
    let count = 0
    for (const line of lines) {
        if (headerRe.test(line)) count++
        else if (bulletRe.test(line)) count++
        else if (numberRe.test(line)) count++
        else if (tableRe.test(line)) count++
    }
    return count
}

export function clamp01(x: number): number {
    return Math.max(0, Math.min(1, x))
}

export function prAiScore(pr: HistoryPr): number {
    const bodyChars = pr.bodyChars ?? 0
    const bodyStructure = pr.bodyStructure ?? 0
    const sBody = clamp01(Math.log10(bodyChars + 1) / Math.log10(3000))
    const sStructure = clamp01(bodyStructure / 12)

    const commitChars = median(pr.commits.map((c) => c.messageChars ?? 0)) ?? 0
    const sCommit = clamp01(Math.log10(commitChars + 1) / Math.log10(400))

    const score = 0.4 * sBody + 0.2 * sStructure + 0.4 * sCommit
    const hasMarker = pr.hasAiMarker === true || pr.commits.some((c) => c.hasAiMarker)
    return hasMarker ? Math.max(score, 0.9) : score
}

export function aiUsageTrend(
    prs: HistoryPr[],
    sinceIso: string,
    days: number
): Record<string, { buckets: AiBucket[]; markerRate: number | null; prCount: number }> {
    const bucketDays = days > 90 ? 30 : 7
    const sinceTime = new Date(sinceIso).getTime()

    const byDev: Record<string, {
        prsByBucket: Record<number, HistoryPr[]>
        commentsByBucket: Record<number, HistoryComment[]>
        markerPrCount: number
        totalPrCount: number
    }> = {}

    // Process PRs
    for (const pr of prs) {
        if (pr.createdAt < sinceIso) continue
        if (BOT_AUTHOR_RE.test(pr.author)) continue
        const hoursSince = hoursBetween(sinceIso, pr.createdAt)
        const bucketIndex = Math.floor(hoursSince / 24 / bucketDays)
        if (!byDev[pr.author]) {
            byDev[pr.author] = {
                prsByBucket: {},
                commentsByBucket: {},
                markerPrCount: 0,
                totalPrCount: 0,
            }
        }
        byDev[pr.author].prsByBucket[bucketIndex] ??= []
        byDev[pr.author].prsByBucket[bucketIndex].push(pr)
        byDev[pr.author].totalPrCount++
        if (pr.hasAiMarker === true || pr.commits.some((c) => c.hasAiMarker)) {
            byDev[pr.author].markerPrCount++
        }
    }

    // Process comments
    for (const pr of prs) {
        for (const comment of pr.comments) {
            if (!comment.author || !comment.createdAt || comment.createdAt < sinceIso) continue
            if (BOT_AUTHOR_RE.test(comment.author)) continue
            const hoursSince = hoursBetween(sinceIso, comment.createdAt)
            const bucketIndex = Math.floor(hoursSince / 24 / bucketDays)
            if (!byDev[comment.author]) {
                byDev[comment.author] = {
                    prsByBucket: {},
                    commentsByBucket: {},
                    markerPrCount: 0,
                    totalPrCount: 0,
                }
            }
            byDev[comment.author].commentsByBucket[bucketIndex] ??= []
            byDev[comment.author].commentsByBucket[bucketIndex].push(comment)
        }
    }

    const result: Record<string, { buckets: AiBucket[]; markerRate: number | null; prCount: number }> = {}

    for (const dev of Object.keys(byDev)) {
        const devData = byDev[dev]
        const allBucketIndices = new Set<number>()
        Object.keys(devData.prsByBucket).forEach((idx) => allBucketIndices.add(parseInt(idx)))
        Object.keys(devData.commentsByBucket).forEach((idx) => allBucketIndices.add(parseInt(idx)))

        const buckets: AiBucket[] = []
        for (const idx of Array.from(allBucketIndices).sort((a, b) => a - b)) {
            const bucketStartTime = sinceTime + idx * bucketDays * 24 * 60 * 60 * 1000
            const bucketStartDate = new Date(bucketStartTime)
            const bucketStartStr = bucketStartDate.toISOString().split('T')[0]

            const prScores = (devData.prsByBucket[idx] ?? []).map((pr) => prAiScore(pr))
            const commentChars = (devData.commentsByBucket[idx] ?? []).map((c) => c.chars ?? 0)

            let score: number
            if (prScores.length > 0 && commentChars.length > 0) {
                const meanPrScore = prScores.reduce((a, b) => a + b, 0) / prScores.length
                const medianCommentChars = median(commentChars) ?? 0
                const sComment = clamp01(Math.log10(medianCommentChars + 1) / Math.log10(800))
                score = Math.round(100 * (0.75 * meanPrScore + 0.25 * sComment))
            } else if (prScores.length > 0) {
                const meanPrScore = prScores.reduce((a, b) => a + b, 0) / prScores.length
                score = Math.round(100 * meanPrScore)
            } else if (commentChars.length > 0) {
                const medianCommentChars = median(commentChars) ?? 0
                const sComment = clamp01(Math.log10(medianCommentChars + 1) / Math.log10(800))
                score = Math.round(100 * sComment)
            } else {
                continue
            }

            buckets.push({
                bucketStart: bucketStartStr,
                score,
                prCount: prScores.length,
                commentCount: commentChars.length,
            })
        }

        const markerRate = devData.totalPrCount === 0 ? null : Math.round(100 * devData.markerPrCount / devData.totalPrCount)

        result[dev] = {
            buckets,
            markerRate,
            prCount: devData.totalPrCount,
        }
    }

    return result
}

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
    aiUsage: Record<string, { buckets: AiBucket[]; markerRate: number | null; prCount: number }>
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

    lines.push('', `AI usage heuristic (0-100 by ${args.days <= 90 ? 'week' : 'month'}; verbosity + markers):`)
    const devs = Object.keys(args.aiUsage).sort()
    if (devs.length === 0) {
        lines.push('  (no data)')
    } else {
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        for (const dev of devs) {
            const data = args.aiUsage[dev]
            const bucketLabels = data.buckets.map((b) => {
                const date = new Date(b.bucketStart)
                const month = monthNames[date.getUTCMonth()]
                const day = String(date.getUTCDate()).padStart(2, '0')
                return `${month}${day}:${b.score}`
            }).join(' ')
            const markerLabel = data.markerRate === null ? 'n/a' : `${data.markerRate}%`
            lines.push(`  ${dev.padEnd(16)} ${bucketLabels}  (AI-marker PRs: ${markerLabel})`)
        }
    }
    return lines.join('\n')
}
