import { quantizeFeedScore, type FeedRankingConfig } from "@civfix/shared"

export interface FeedCandidate {
  id: string
  authorId: string
  createdAtMs: number
  likeCount: number
  replyCount: number
  repostCount: number
  hasMedia: boolean
  hasReport: boolean
  hasLiveEvent: boolean
  authorFollowed: boolean
  authorIsViewer: boolean
  viewerMentioned: boolean
  authorOrgVerified: boolean
  distanceKm: number | null
  alreadySeen: boolean
}

export interface RankedCandidate {
  id: string
  authorId: string
  score: number
}

const MS_PER_HOUR = 3_600_000

export function quantizeClock(nowMs: number, clockBucketSeconds: number): number {
  const bucketMs = Math.max(1, Math.trunc(clockBucketSeconds)) * 1000
  return Math.floor(nowMs / bucketMs) * bucketMs
}

export function proximity(distanceKm: number | null, radiusKm: number): number {
  if (distanceKm === null || !Number.isFinite(distanceKm)) return 0
  if (radiusKm <= 0) return 0
  return Math.max(0, 1 - Math.max(0, distanceKm) / radiusKm)
}

export function recency(ageHours: number, cfg: FeedRankingConfig): number {
  const age = Math.max(0, ageHours)
  const decayed = 0.5 ** (age / cfg.halfLifeHours)
  return cfg.decayFloor + (1 - cfg.decayFloor) * decayed
}

export function diversityMultiplier(authorRank: number, cfg: FeedRankingConfig): number {
  const rank = Math.max(0, Math.trunc(authorRank))
  return cfg.diversityFloor + (1 - cfg.diversityFloor) * cfg.diversityDecay ** rank
}

function logScale(count: number): number {
  return Math.log1p(Math.max(0, count))
}

export type GlobalCandidate = Omit<
  FeedCandidate,
  "authorFollowed" | "authorIsViewer" | "viewerMentioned" | "distanceKm"
>

export type ViewerCandidate = Pick<
  FeedCandidate,
  "authorFollowed" | "authorIsViewer" | "viewerMentioned" | "distanceKm"
>

export function globalScore(candidate: GlobalCandidate, cfg: FeedRankingConfig): number {
  return (
    cfg.baseWeight +
    (candidate.authorOrgVerified ? cfg.orgVerifiedWeight : 0) +
    (candidate.hasLiveEvent ? cfg.attachEventWeight : 0) +
    (candidate.hasReport ? cfg.attachReportWeight : 0) +
    (candidate.hasMedia ? cfg.imageWeight : 0) +
    cfg.likeWeight * logScale(candidate.likeCount) +
    cfg.replyWeight * logScale(candidate.replyCount) +
    cfg.repostWeight * logScale(candidate.repostCount)
  )
}

export function viewerScore(candidate: ViewerCandidate, cfg: FeedRankingConfig): number {
  return (
    (candidate.authorFollowed ? cfg.followWeight : 0) +
    (candidate.authorIsViewer ? cfg.selfWeight : 0) +
    (candidate.viewerMentioned ? cfg.mentionWeight : 0) +
    cfg.nearbyWeight * proximity(candidate.distanceKm, cfg.nearbyRadiusKm)
  )
}

export function rawScore(candidate: FeedCandidate, cfg: FeedRankingConfig): number {
  return globalScore(candidate, cfg) + viewerScore(candidate, cfg)
}

const FNV_OFFSET_BASIS = 2_166_136_261
const FNV_PRIME = 16_777_619
const UINT32_SPAN = 4_294_967_296

function fnv1a32(text: string): number {
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

function avalanche(value: number): number {
  let hash = value >>> 0
  hash ^= hash >>> 16
  hash = Math.imul(hash, 2_246_822_507)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 3_266_489_909)
  hash ^= hash >>> 16
  return hash >>> 0
}

export function jitterUnit(seed: number, postId: string): number {
  return avalanche(fnv1a32(`${seed}:${postId}`)) / UINT32_SPAN
}

function jitterMultiplier(cfg: FeedRankingConfig, seed: number, postId: string): number {
  if (cfg.jitterAmount === 0) return 1
  return 1 + cfg.jitterAmount * (2 * jitterUnit(seed, postId) - 1)
}

export function bucketSeed(viewerKey: string, filter: string, nowBucketMs: number): number {
  return avalanche(fnv1a32(`${viewerKey}|${filter}|${nowBucketMs}`))
}

export function scoreCandidate(
  candidate: FeedCandidate,
  cfg: FeedRankingConfig,
  nowBucketMs: number,
  seed: number,
): number {
  const ageHours = Math.max(0, (nowBucketMs - candidate.createdAtMs) / MS_PER_HOUR)
  const seen = candidate.alreadySeen ? cfg.seenDiscount : 1
  return (
    Math.max(0, rawScore(candidate, cfg)) *
    recency(ageHours, cfg) *
    seen *
    jitterMultiplier(cfg, seed, candidate.id)
  )
}

function byScoreThenId(a: RankedCandidate, b: RankedCandidate): number {
  if (a.score !== b.score) return b.score - a.score
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

export function rankCandidates(
  candidates: readonly FeedCandidate[],
  cfg: FeedRankingConfig,
  nowMs: number,
  seed: number,
): RankedCandidate[] {
  const nowBucketMs = quantizeClock(nowMs, cfg.clockBucketSeconds)
  const base = candidates.map((candidate) => ({
    id: candidate.id,
    authorId: candidate.authorId,
    score: quantizeFeedScore(scoreCandidate(candidate, cfg, nowBucketMs, seed)),
  }))
  base.sort(byScoreThenId)

  const seenPerAuthor = new Map<string, number>()
  for (const entry of base) {
    const rank = seenPerAuthor.get(entry.authorId) ?? 0
    seenPerAuthor.set(entry.authorId, rank + 1)
    entry.score = quantizeFeedScore(entry.score * diversityMultiplier(rank, cfg))
  }
  base.sort(byScoreThenId)
  return base
}

export function applyCutoff(
  ranked: readonly RankedCandidate[],
  cfg: FeedRankingConfig,
): RankedCandidate[] {
  const kept = ranked.filter((entry) => entry.score >= cfg.minScore)
  if (kept.length < cfg.minPageItems) return [...ranked]
  return kept
}
