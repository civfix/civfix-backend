import { describe, expect, it } from "vitest"
import { DEFAULT_FEED_RANKING, FeedRankingConfigSchema } from "@civfix/shared"
import type { FeedRankingConfig } from "@civfix/shared"
import {
  applyCutoff,
  bucketSeed,
  diversityMultiplier,
  globalScore,
  jitterUnit,
  proximity,
  quantizeClock,
  rankCandidates,
  rawScore,
  recency,
  scoreCandidate,
  viewerScore,
  type FeedCandidate,
} from "../../src/services/feed-ranking.js"

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0)
const HOUR = 3_600_000

const SEED = 0

const CFG: FeedRankingConfig = { ...DEFAULT_FEED_RANKING, jitterAmount: 0 }

const JITTERED = DEFAULT_FEED_RANKING

function candidate(over: Partial<FeedCandidate> = {}): FeedCandidate {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    authorId: "author-a",
    createdAtMs: NOW,
    likeCount: 0,
    replyCount: 0,
    repostCount: 0,
    hasMedia: false,
    hasReport: false,
    hasLiveEvent: false,
    authorFollowed: false,
    authorIsViewer: false,
    viewerMentioned: false,
    authorOrgVerified: false,
    distanceKm: null,
    alreadySeen: false,
    ...over,
  }
}

describe("feed ranking: each weight term in isolation", () => {
  const base = rawScore(candidate(), CFG)

  it("starts every eligible post at the base weight", () => {
    expect(base).toBe(CFG.baseWeight)
  })

  const flags: Array<[keyof FeedCandidate, keyof FeedRankingConfig]> = [
    ["authorFollowed", "followWeight"],
    ["authorIsViewer", "selfWeight"],
    ["viewerMentioned", "mentionWeight"],
    ["authorOrgVerified", "orgVerifiedWeight"],
    ["hasLiveEvent", "attachEventWeight"],
    ["hasReport", "attachReportWeight"],
    ["hasMedia", "imageWeight"],
  ]

  for (const [flag, weight] of flags) {
    it(`adds exactly ${weight} when ${flag} is set`, () => {
      const score = rawScore(candidate({ [flag]: true } as Partial<FeedCandidate>), CFG)
      expect(score - base).toBeCloseTo(CFG[weight] as number, 10)
    })
  }

  it("scores an ended event as no event at all", () => {
    expect(rawScore(candidate({ hasLiveEvent: false }), CFG)).toBe(base)
  })
})

describe("feed ranking: proximity", () => {
  it("is 1 at the viewer's own point and 0 at the radius", () => {
    expect(proximity(0, 40)).toBe(1)
    expect(proximity(40, 40)).toBe(0)
  })

  it("falls off linearly, with no discontinuity at the edge", () => {
    expect(proximity(20, 40)).toBeCloseTo(0.5, 10)
    expect(proximity(39.9, 40)).toBeCloseTo(0.0025, 10)
  })

  it("never goes negative beyond the radius", () => {
    expect(proximity(4000, 40)).toBe(0)
  })

  it("is zero when either the post or the viewer has no point", () => {
    expect(proximity(null, 40)).toBe(0)
  })
})

describe("feed ranking: recency decay", () => {
  it("is 1 at age zero", () => {
    expect(recency(0, CFG)).toBeCloseTo(1, 10)
  })

  it("is halfway to the floor at one half-life", () => {
    const expected = CFG.decayFloor + (1 - CFG.decayFloor) * 0.5
    expect(recency(CFG.halfLifeHours, CFG)).toBeCloseTo(expected, 10)
  })

  it("decreases monotonically and never crosses the floor", () => {
    let previous = recency(0, CFG)
    for (const hours of [1, 6, 24, 36, 72, 24 * 7, 24 * 30]) {
      const value = recency(hours, CFG)
      expect(value).toBeLessThan(previous)
      expect(value).toBeGreaterThan(CFG.decayFloor)
      previous = value
    }
    expect(recency(24 * 365, CFG)).toBeGreaterThanOrEqual(CFG.decayFloor)
  })

  it("approaches but never reaches zero, so an old unresolved report is demoted not erased", () => {
    expect(recency(24 * 3650, CFG)).toBeGreaterThanOrEqual(CFG.decayFloor)
  })

  it("treats a future-dated post as brand new rather than boosting it", () => {
    expect(recency(-100, CFG)).toBeCloseTo(1, 10)
  })
})

describe("feed ranking: engagement is log-scaled, not stepped", () => {
  const withLikes = (likes: number) => rawScore(candidate({ likeCount: likes }), CFG)

  it("has diminishing returns: 0 to 10 likes is worth more than 10 to 50", () => {
    expect(withLikes(10) - withLikes(0)).toBeGreaterThan(withLikes(50) - withLikes(10))
  })

  it("has no cliff between 49 and 50 likes", () => {
    expect(withLikes(50) - withLikes(49)).toBeLessThan(0.1)
  })

  it("keeps rewarding a runaway post, slowly", () => {
    expect(withLikes(5000)).toBeGreaterThan(withLikes(200))
  })

  it("weights a reply above a repost above a like", () => {
    expect(CFG.replyWeight).toBeGreaterThan(CFG.repostWeight)
    expect(CFG.repostWeight).toBeGreaterThan(CFG.likeWeight)
  })
})

describe("feed ranking: author diversity", () => {
  it("reproduces the Twitter DiversityDiscountProvider curve", () => {
    expect(diversityMultiplier(0, CFG)).toBeCloseTo(1, 10)
    expect(diversityMultiplier(1, CFG)).toBeCloseTo(0.625, 10)
    expect(diversityMultiplier(2, CFG)).toBeCloseTo(0.4375, 10)
  })

  it("never discounts below the floor", () => {
    expect(diversityMultiplier(10, CFG)).toBeGreaterThanOrEqual(CFG.diversityFloor)
    expect(diversityMultiplier(100, CFG)).toBeCloseTo(CFG.diversityFloor, 10)
  })

  it("stops one enthusiastic poster from taking the whole page", () => {
    const flood = Array.from({ length: 5 }, (_, i) =>
      candidate({
        id: `a${i}`,
        authorId: "flooder",
        authorFollowed: true,
        likeCount: 50,
        createdAtMs: NOW - i * 60_000,
      }),
    )
    const other = candidate({ id: "b0", authorId: "someone-else", authorFollowed: true })

    const undiscounted = [...flood, other]
      .map((c) => ({ id: c.id, score: scoreCandidate(c, CFG, NOW, SEED) }))
      .sort((a, b) => b.score - a.score)
    expect(undiscounted.findIndex((entry) => entry.id === "b0")).toBe(flood.length)

    const ranked = rankCandidates([...flood, other], CFG, NOW, SEED)
    expect(ranked.findIndex((entry) => entry.id === "b0")).toBeLessThan(flood.length)
  })

  it("applies the discount per author, not globally", () => {
    const ranked = rankCandidates(
      [
        candidate({ id: "a1", authorId: "a" }),
        candidate({ id: "b1", authorId: "b" }),
        candidate({ id: "c1", authorId: "c" }),
      ],
      CFG,
      NOW,
      SEED,
    )
    const scores = new Set(ranked.map((entry) => entry.score))
    expect(scores.size).toBe(1)
  })
})

describe("feed ranking: seen discount", () => {
  it("demotes a post the viewer was already served", () => {
    const fresh = scoreCandidate(candidate(), CFG, NOW, SEED)
    const seen = scoreCandidate(candidate({ alreadySeen: true }), CFG, NOW, SEED)
    expect(seen).toBeCloseTo(fresh * CFG.seenDiscount, 10)
  })
})

describe("feed ranking: clock quantisation keeps a cursor stable", () => {
  it("buckets two instants inside the same minute to the same value", () => {
    const a = quantizeClock(NOW + 1_000, CFG.clockBucketSeconds)
    const b = quantizeClock(NOW + 59_000, CFG.clockBucketSeconds)
    expect(a).toBe(b)
  })

  it("produces byte-identical scores 59 seconds apart", () => {
    const rows = [candidate({ id: "a", createdAtMs: NOW - 5 * HOUR, likeCount: 7 })]
    const first = rankCandidates(rows, CFG, NOW + 1_000, SEED)
    const second = rankCandidates(rows, CFG, NOW + 59_000, SEED)
    expect(second).toEqual(first)
  })

  it("does move the score once the bucket rolls over", () => {
    const rows = [candidate({ id: "a", createdAtMs: NOW - 5 * HOUR })]
    const inBucket = rankCandidates(rows, CFG, NOW, SEED)
    const nextBucket = rankCandidates(rows, CFG, NOW + 61_000, SEED)
    expect(nextBucket[0]!.score).toBeLessThan(inBucket[0]!.score)
  })
})

describe("feed ranking: the worked examples from the design", () => {
  const at = (hoursAgo: number) => NOW - hoursAgo * HOUR

  it("followed author, 2 h old, 3 likes, 1 reply scores ~115.9", () => {
    const score = scoreCandidate(
      candidate({ authorFollowed: true, createdAtMs: at(2), likeCount: 3, replyCount: 1 }),
      CFG,
      NOW,
      SEED,
    )
    expect(score).toBeCloseTo(115.9, 1)
  })

  it("stranger 5 km away, verified org, report, image, 12 likes, 3 d old scores ~125.1", () => {
    const score = scoreCandidate(
      candidate({
        createdAtMs: at(72),
        distanceKm: 5,
        authorOrgVerified: true,
        hasReport: true,
        hasMedia: true,
        likeCount: 12,
      }),
      CFG,
      NOW,
      SEED,
    )
    expect(score).toBeCloseTo(125.1, 1)
  })

  it("stranger, no location, 2 likes, 1 h old scores ~13.1 and clears the cutoff", () => {
    const score = scoreCandidate(candidate({ createdAtMs: at(1), likeCount: 2 }), CFG, NOW, SEED)
    expect(score).toBeCloseTo(13.1, 1)
    expect(score).toBeGreaterThanOrEqual(CFG.minScore)
  })

  it("the same post at 30 days old scores ~2.0 and falls below the cutoff", () => {
    const score = scoreCandidate(
      candidate({ createdAtMs: at(24 * 30), likeCount: 2 }),
      CFG,
      NOW,
      SEED,
    )
    expect(score).toBeCloseTo(2.0, 1)
    expect(score).toBeLessThan(CFG.minScore)
  })

  it("stranger, no location, no engagement, 1 h old scores ~9.9, below the cutoff", () => {
    const score = scoreCandidate(candidate({ createdAtMs: at(1) }), CFG, NOW, SEED)
    expect(score).toBeCloseTo(9.84, 2)
    expect(score).toBeLessThan(CFG.minScore)
  })
})

describe("feed ranking: ordering", () => {
  it("orders by score descending with a stable id tiebreak", () => {
    const ranked = rankCandidates(
      [
        candidate({ id: "aaaaaaaa-0000-0000-0000-000000000000", authorId: "x" }),
        candidate({ id: "cccccccc-0000-0000-0000-000000000000", authorId: "y" }),
        candidate({ id: "bbbbbbbb-0000-0000-0000-000000000000", authorId: "z" }),
      ],
      CFG,
      NOW,
      SEED,
    )
    expect(ranked.map((entry) => entry.id)).toEqual([
      "cccccccc-0000-0000-0000-000000000000",
      "bbbbbbbb-0000-0000-0000-000000000000",
      "aaaaaaaa-0000-0000-0000-000000000000",
    ])
  })

  it("is deterministic for the same inputs and clock", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      candidate({
        id: `${i}`.padStart(8, "0") + "-0000-0000-0000-000000000000",
        authorId: `author-${i % 4}`,
        createdAtMs: NOW - i * HOUR,
        likeCount: i,
      }),
    )
    expect(rankCandidates(rows, CFG, NOW, SEED)).toEqual(rankCandidates(rows, CFG, NOW, SEED))
  })

  it("never emits a negative score", () => {
    const hostile: FeedRankingConfig = { ...CFG, baseWeight: 0 }
    const score = scoreCandidate(candidate({ createdAtMs: NOW - 24 * 365 * HOUR }), hostile, NOW, SEED)
    expect(score).toBeGreaterThanOrEqual(0)
  })
})

describe("feed ranking: cutoff and cold start", () => {
  const weak = () =>
    Array.from({ length: 3 }, (_, i) =>
      candidate({
        id: `${i}`.padStart(8, "0") + "-0000-0000-0000-000000000000",
        authorId: `author-${i}`,
        createdAtMs: NOW - 24 * 30 * HOUR,
      }),
    )

  it("suspends the cutoff when too little clears it", () => {
    const ranked = rankCandidates(weak(), CFG, NOW, SEED)
    expect(ranked.every((entry) => entry.score < CFG.minScore)).toBe(true)
    expect(applyCutoff(ranked, CFG)).toHaveLength(3)
  })

  it("decides leniency from the ranked set alone, so every page of one set agrees", () => {
    const ranked = rankCandidates(weak(), CFG, NOW, SEED)
    expect(applyCutoff(ranked, CFG)).toEqual(applyCutoff(ranked, CFG))
    expect(applyCutoff(ranked, CFG).map((entry) => entry.id)).toEqual(
      ranked.map((entry) => entry.id),
    )
  })

  it("applies the cutoff normally once page 1 has enough strong items", () => {
    const strong = Array.from({ length: 6 }, (_, i) =>
      candidate({
        id: `s${i}`,
        authorId: `author-${i}`,
        authorFollowed: true,
        createdAtMs: NOW,
      }),
    )
    const ranked = rankCandidates([...strong, ...weak()], CFG, NOW, SEED)
    const kept = applyCutoff(ranked, CFG)
    expect(kept).toHaveLength(6)
    expect(kept.every((entry) => entry.score >= CFG.minScore)).toBe(true)
  })

  it("gives a brand-new account with no follows and no location a non-empty page 1", () => {
    const strangers = Array.from({ length: 3 }, (_, i) =>
      candidate({ id: `n${i}`, authorId: `author-${i}`, createdAtMs: NOW - HOUR }),
    )
    const ranked = rankCandidates(strangers, CFG, NOW, SEED)
    expect(applyCutoff(ranked, CFG).length).toBeGreaterThan(0)
  })
})

describe("feed ranking: the global half is viewer-independent by construction", () => {
  const viewerFields: Array<Partial<FeedCandidate>> = [
    { authorFollowed: true },
    { authorIsViewer: true },
    { viewerMentioned: true },
    { distanceKm: 0 },
    { distanceKm: 2 },
    { authorFollowed: true, authorIsViewer: true, viewerMentioned: true, distanceKm: 1 },
  ]

  it("scores the same post identically for every viewer", () => {
    const anonymous = globalScore(candidate(), CFG)
    for (const over of viewerFields) {
      expect(globalScore(candidate(over), CFG)).toBe(anonymous)
    }
  })

  it("still reacts to the post's own properties", () => {
    const plain = globalScore(candidate(), CFG)
    expect(globalScore(candidate({ authorOrgVerified: true }), CFG) - plain).toBeCloseTo(
      CFG.orgVerifiedWeight,
      10,
    )
    expect(globalScore(candidate({ hasReport: true }), CFG) - plain).toBeCloseTo(
      CFG.attachReportWeight,
      10,
    )
    expect(globalScore(candidate({ likeCount: 12 }), CFG)).toBeGreaterThan(plain)
  })

  it("carries every viewer-specific term in the viewer half", () => {
    expect(viewerScore(candidate(), CFG)).toBe(0)
    expect(viewerScore(candidate({ authorFollowed: true }), CFG)).toBeCloseTo(CFG.followWeight, 10)
    expect(viewerScore(candidate({ authorIsViewer: true }), CFG)).toBeCloseTo(CFG.selfWeight, 10)
    expect(viewerScore(candidate({ viewerMentioned: true }), CFG)).toBeCloseTo(CFG.mentionWeight, 10)
    expect(viewerScore(candidate({ distanceKm: 0 }), CFG)).toBeCloseTo(CFG.nearbyWeight, 10)
  })

  it("sums back to the raw score, so the split is a regrouping not a rewrite", () => {
    for (const over of viewerFields) {
      const c = candidate({ ...over, likeCount: 9, hasReport: true, authorOrgVerified: true })
      expect(globalScore(c, CFG) + viewerScore(c, CFG)).toBe(rawScore(c, CFG))
    }
  })
})

describe("feed ranking: location outranks affinity under the 0.54.0 weights", () => {
  it("puts a stranger two kilometres away above a followed author across town", () => {
    const nearbyStranger = candidate({
      id: "aaaaaaaa-0000-0000-0000-000000000000",
      authorId: "stranger",
      distanceKm: 2,
    })
    const distantFriend = candidate({
      id: "ffffffff-0000-0000-0000-000000000000",
      authorId: "friend",
      authorFollowed: true,
      distanceKm: 35,
    })

    const ranked = rankCandidates([distantFriend, nearbyStranger], CFG, NOW, SEED)
    expect(ranked[0]!.id).toBe(nearbyStranger.id)
    expect(rawScore(nearbyStranger, CFG)).toBeGreaterThan(rawScore(distantFriend, CFG))
  })

  it("keeps that ordering even at the widest jitter swing", () => {
    const nearbyStranger = candidate({ id: "near", authorId: "stranger", distanceKm: 2 })
    const distantFriend = candidate({
      id: "far",
      authorId: "friend",
      authorFollowed: true,
      distanceKm: 35,
    })
    const worst = rawScore(nearbyStranger, CFG) * (1 - JITTERED.jitterAmount)
    const best = rawScore(distantFriend, CFG) * (1 + JITTERED.jitterAmount)
    expect(worst).toBeGreaterThan(best)
  })

  it("does not let the follow boost alone beat being in the neighbourhood", () => {
    const followedNowhere = candidate({ authorFollowed: true, distanceKm: null })
    const strangerNextDoor = candidate({ distanceKm: 0 })
    expect(viewerScore(strangerNextDoor, CFG)).toBeGreaterThan(viewerScore(followedNowhere, CFG))
  })
})

describe("feed ranking: seeded jitter", () => {
  const spread = () =>
    Array.from({ length: 40 }, (_, i) =>
      candidate({
        id: `${i}`.padStart(8, "0") + "-0000-0000-0000-000000000000",
        authorId: `author-${i}`,
        authorFollowed: true,
      }),
    )

  it("draws a uniform value in [0, 1) for any seed and post id", () => {
    for (let seed = 0; seed < 50; seed += 1) {
      for (const id of ["a", "post-1", "11111111-1111-1111-1111-111111111111"]) {
        const u = jitterUnit(seed, id)
        expect(u).toBeGreaterThanOrEqual(0)
        expect(u).toBeLessThan(1)
      }
    }
  })

  it("is a pure function of the seed and the post id", () => {
    expect(jitterUnit(7, "post-a")).toBe(jitterUnit(7, "post-a"))
    expect(jitterUnit(7, "post-a")).not.toBe(jitterUnit(8, "post-a"))
    expect(jitterUnit(7, "post-a")).not.toBe(jitterUnit(7, "post-b"))
  })

  it("never moves a score outside plus or minus jitterAmount", () => {
    for (const row of spread()) {
      const plain = scoreCandidate(row, CFG, NOW, SEED)
      for (let seed = 0; seed < 25; seed += 1) {
        const jittered = scoreCandidate(row, JITTERED, NOW, seed)
        expect(jittered).toBeGreaterThanOrEqual(plain * (1 - JITTERED.jitterAmount))
        expect(jittered).toBeLessThanOrEqual(plain * (1 + JITTERED.jitterAmount))
      }
    }
  })

  it("reproduces the unjittered score byte for byte when jitterAmount is 0", () => {
    const rows = spread()
    const first = rankCandidates(rows, CFG, NOW, 1)
    const second = rankCandidates(rows, CFG, NOW, 987_654_321)
    expect(second).toEqual(first)
    for (const row of rows) {
      expect(scoreCandidate(row, CFG, NOW, 4_242)).toBe(scoreCandidate(row, CFG, NOW, SEED))
    }
  })

  it("produces an identical ranking for the same seed, every time", () => {
    const rows = spread()
    expect(rankCandidates(rows, JITTERED, NOW, 31)).toEqual(rankCandidates(rows, JITTERED, NOW, 31))
  })

  it("reshuffles a near-tied set when the seed changes", () => {
    const rows = spread()
    const unjittered = rankCandidates(rows, CFG, NOW, SEED).map((entry) => entry.id)
    expect(new Set(rankCandidates(rows, CFG, NOW, SEED).map((e) => e.score)).size).toBe(1)

    const a = rankCandidates(rows, JITTERED, NOW, 1).map((entry) => entry.id)
    const b = rankCandidates(rows, JITTERED, NOW, 2).map((entry) => entry.id)
    expect(a).not.toEqual(b)
    expect(a).not.toEqual(unjittered)
    expect([...a].sort()).toEqual([...b].sort())
  })

  it("keeps the score non-negative at the widest jitter", () => {
    const hostile: FeedRankingConfig = { ...JITTERED, jitterAmount: 1, baseWeight: 0 }
    for (let seed = 0; seed < 25; seed += 1) {
      const score = scoreCandidate(candidate({ createdAtMs: NOW - HOUR }), hostile, NOW, seed)
      expect(score).toBeGreaterThanOrEqual(0)
    }
  })
})

describe("feed ranking: the deterministic bucket seed", () => {
  it("agrees for two recomputations inside the same clock bucket", () => {
    const bucket = quantizeClock(NOW + 5_000, CFG.clockBucketSeconds)
    expect(bucketSeed("viewer-1", "all", bucket)).toBe(
      bucketSeed("viewer-1", "all", quantizeClock(NOW + 55_000, CFG.clockBucketSeconds)),
    )
  })

  it("moves with the viewer, the filter and the bucket", () => {
    const bucket = quantizeClock(NOW, CFG.clockBucketSeconds)
    const base = bucketSeed("viewer-1", "all", bucket)
    expect(bucketSeed("viewer-2", "all", bucket)).not.toBe(base)
    expect(bucketSeed("viewer-1", "events", bucket)).not.toBe(base)
    expect(bucketSeed("viewer-1", "all", bucket + 60_000)).not.toBe(base)
  })

  it("stays a non-negative 32-bit integer", () => {
    for (let i = 0; i < 50; i += 1) {
      const seed = bucketSeed(`viewer-${i}`, "all", NOW + i * 60_000)
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(0)
      expect(seed).toBeLessThan(2 ** 32)
    }
  })
})

describe("FeedRankingConfigSchema", () => {
  it("fills every knob from an empty object", () => {
    const parsed = FeedRankingConfigSchema.parse({})
    expect(parsed).toEqual(DEFAULT_FEED_RANKING)
    expect(Object.keys(parsed)).toHaveLength(28)
  })

  it("merges a partial override onto the defaults", () => {
    const parsed = FeedRankingConfigSchema.parse({ halfLifeHours: 12, followWeight: 70 })
    expect(parsed.halfLifeHours).toBe(12)
    expect(parsed.followWeight).toBe(70)
    expect(parsed.minScore).toBe(DEFAULT_FEED_RANKING.minScore)
  })

  it("rejects an unknown key rather than silently ignoring the knob", () => {
    expect(FeedRankingConfigSchema.safeParse({ folowWeight: 70 }).success).toBe(false)
  })

  it("rejects an out-of-range value", () => {
    expect(FeedRankingConfigSchema.safeParse({ decayFloor: 1.5 }).success).toBe(false)
    expect(FeedRankingConfigSchema.safeParse({ halfLifeHours: 0 }).success).toBe(false)
    expect(FeedRankingConfigSchema.safeParse({ candidateCap: 5000 }).success).toBe(false)
  })

  it("rejects a non-integer where the knob is a count", () => {
    expect(FeedRankingConfigSchema.safeParse({ minPageItems: 2.5 }).success).toBe(false)
  })
})
