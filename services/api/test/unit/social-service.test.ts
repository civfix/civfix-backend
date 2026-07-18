import { describe, it, expect } from "vitest"
import { avatarGradient, stableHash, AVATAR_PALETTE } from "@civfix/shared"
import {
  makeSocialService,
  toPersonDTO,
  type SocialNotifier,
  type SocialService,
  type PersonView,
} from "../../src/services/social-service.js"
import {
  InMemorySocialRepository,
  makeCleanupRecord,
} from "../helpers/social.js"


const A = "11111111-1111-1111-1111-111111111111"
const B = "22222222-2222-2222-2222-222222222222"
const C = "33333333-3333-3333-3333-333333333333"

class SpyNotifier implements SocialNotifier {
  readonly calls: Array<{ followeeId: string; follower: PersonView }> = []
  shouldThrow = false
  onNewFollower(args: { followeeId: string; follower: PersonView }): Promise<void> {
    this.calls.push(args)
    if (this.shouldThrow) return Promise.reject(new Error("notifier boom"))
    return Promise.resolve()
  }
}

function makeHarness(): {
  repo: InMemorySocialRepository
  notifier: SpyNotifier
  service: SocialService
} {
  const repo = new InMemorySocialRepository()
  const notifier = new SpyNotifier()
  const service = makeSocialService({ repo, notifier })
  return { repo, notifier, service }
}


describe("avatarGradient", () => {
  it("is deterministic: same seed yields the same pair across calls", () => {
    const first = avatarGradient(A)
    const second = avatarGradient(A)
    expect(first).toEqual(second)
    expect(first).toEqual(avatarGradient(A))
  })

  it("returns two colors, both members of the brand palette", () => {
    for (const seed of [A, B, C, "jane", "@bob", "", "x"]) {
      const [from, to] = avatarGradient(seed)
      expect(AVATAR_PALETTE).toContain(from)
      expect(AVATAR_PALETTE).toContain(to)
    }
  })

  it("picks two DISTINCT colors", () => {
    for (const seed of [A, B, C, "jane", "@bob", "alice", "z", "0", "seed-123"]) {
      const [from, to] = avatarGradient(seed)
      expect(from).not.toEqual(to)
    }
  })

  it("different seeds can yield different gradients (not a constant)", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) seen.add(avatarGradient(`user-${i}`).join(">"))
    expect(seen.size).toBeGreaterThan(5)
  })

  it("stableHash is a pure unsigned 32-bit value, stable per input", () => {
    expect(stableHash("abc")).toBe(stableHash("abc"))
    expect(stableHash("abc")).toBeGreaterThanOrEqual(0)
    expect(stableHash("abc")).toBeLessThanOrEqual(0xffffffff)
    expect(stableHash("abc")).not.toBe(stableHash("abd"))
  })
})

describe("toPersonDTO", () => {
  it("derives the avatar gradient from the id and passes through counts + isFollowing", () => {
    const view: PersonView = {
      id: A,
      displayName: "Jane",
      handle: "jane",
      bio: "hi",
      followers: 3,
      following: 7,
      verified: false,
      avatarR2Key: null,
      avatarUrl: null,
      socialLinks: null,
    }
    const dto = toPersonDTO(view, true)
    expect(dto).toEqual({
      id: A,
      name: "Jane",
      handle: "jane",
      bio: "hi",
      avatar: avatarGradient(A),
      followers: 3,
      following: 7,
      isFollowing: true,
      verified: false,
    })
    expect(dto.avatarUrl).toBeUndefined()
  })

  it("surfaces the canonical avatar_url directly (no presign) when set", () => {
    const view: PersonView = {
      id: A,
      displayName: "Jane",
      handle: "jane",
      bio: null,
      followers: 0,
      following: 0,
      verified: false,
      avatarR2Key: null,
      avatarUrl: "https://cdn.example.test/avatars/jane.jpg",
      socialLinks: null,
    }
    expect(toPersonDTO(view, false).avatarUrl).toBe("https://cdn.example.test/avatars/jane.jpg")
  })
})


describe("listPeople", () => {
  it("excludes the viewer and soft-deleted users", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    repo.seedUser({ id: C, displayName: "Carol", deletedAt: new Date() })

    const res = await service.listPeople({ limit: 20 }, { userId: A })
    const ids = res.items.map((p) => p.id)
    expect(ids).toContain(B)
    expect(ids).not.toContain(A)
    expect(ids).not.toContain(C)
  })

  it("filters case-insensitively on handle OR display_name", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice Anderson", handle: "alice" })
    repo.seedUser({ id: B, displayName: "Bob Brown", handle: "bobby" })
    repo.seedUser({ id: C, displayName: "Carol", handle: "ALICEX" })

    const byName = await service.listPeople({ q: "anders", limit: 20 }, { userId: null })
    expect(byName.items.map((p) => p.id)).toEqual([A])

    const byHandle = await service.listPeople({ q: "alice", limit: 20 }, { userId: null })
    expect(byHandle.items.map((p) => p.id).sort()).toEqual([A, C].sort())
  })

  it("reports isFollowing per row relative to the viewer", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    repo.seedUser({ id: C, displayName: "Carol" })
    repo.seedFollow(A, B)

    const res = await service.listPeople({ limit: 20 }, { userId: A })
    const bob = res.items.find((p) => p.id === B)!
    const carol = res.items.find((p) => p.id === C)!
    expect(bob.isFollowing).toBe(true)
    expect(carol.isFollowing).toBe(false)
  })

  it("paginates with a keyset cursor (ordered by display_name, id)", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Aaa" })
    repo.seedUser({ id: B, displayName: "Bbb" })
    repo.seedUser({ id: C, displayName: "Ccc" })

    const page1 = await service.listPeople({ limit: 2 }, { userId: null })
    expect(page1.items.map((p) => p.name)).toEqual(["Aaa", "Bbb"])
    expect(page1.nextCursor).not.toBeNull()

    const page2 = await service.listPeople(
      { limit: 2, cursor: page1.nextCursor! },
      { userId: null },
    )
    expect(page2.items.map((p) => p.name)).toEqual(["Ccc"])
    expect(page2.nextCursor).toBeNull()
  })

  it("attaches an avatar gradient to each person", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    const res = await service.listPeople({ limit: 20 }, { userId: null })
    expect(res.items[0]!.avatar).toEqual(avatarGradient(A))
  })

  it("surfaces the canonical avatar_url on each list row (now that avatar_url is canonical)", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice", avatarUrl: "https://cdn.example.test/a.jpg" })
    repo.seedUser({ id: B, displayName: "Bob" })
    const res = await service.listPeople({ limit: 20 }, { userId: null })
    const alice = res.items.find((p) => p.id === A)!
    const bob = res.items.find((p) => p.id === B)!
    expect(alice.avatarUrl).toBe("https://cdn.example.test/a.jpg")
    expect(bob.avatarUrl).toBeUndefined()
  })
})


describe("followPerson", () => {
  it("follows, is idempotent, and returns the new follower count", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })

    const first = await service.followPerson(A, B)
    expect(first).toEqual({ isFollowing: true, followers: 1 })

    const second = await service.followPerson(A, B)
    expect(second).toEqual({ isFollowing: true, followers: 1 })
  })

  it("rejects following yourself with a VALIDATION error", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    await expect(service.followPerson(A, A)).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("404s following a non-existent person", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    await expect(service.followPerson(A, B)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("triggers a new_follower notification on a NEW follow (once), not on a re-follow", async () => {
    const { repo, notifier, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice", handle: "alice" })
    repo.seedUser({ id: B, displayName: "Bob" })

    await service.followPerson(A, B)
    expect(notifier.calls).toHaveLength(1)
    expect(notifier.calls[0]!.followeeId).toBe(B)
    expect(notifier.calls[0]!.follower.id).toBe(A)

    await service.followPerson(A, B)
    expect(notifier.calls).toHaveLength(1)
  })

  it("still succeeds when the notifier throws (best-effort hook)", async () => {
    const { repo, notifier, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    notifier.shouldThrow = true

    const res = await service.followPerson(A, B)
    expect(res).toEqual({ isFollowing: true, followers: 1 })
    expect(notifier.calls).toHaveLength(1)
  })
})

describe("followPerson block gate", () => {
  it("404s and creates no follow or notification when blocked either way", async () => {
    const repo = new InMemorySocialRepository()
    const notifier = new SpyNotifier()
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    const service = makeSocialService({
      repo,
      notifier,
      isBlockedEitherWay: () => Promise.resolve(true),
    })
    await expect(service.followPerson(A, B)).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(notifier.calls).toHaveLength(0)
    expect(await repo.isFollowing(A, B)).toBe(false)
  })

  it("allows the follow and notifies when not blocked", async () => {
    const repo = new InMemorySocialRepository()
    const notifier = new SpyNotifier()
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    const service = makeSocialService({
      repo,
      notifier,
      isBlockedEitherWay: () => Promise.resolve(false),
    })
    const res = await service.followPerson(A, B)
    expect(res).toEqual({ isFollowing: true, followers: 1 })
    expect(notifier.calls).toHaveLength(1)
  })
})

describe("unfollowPerson", () => {
  it("unfollows and returns the decremented count; idempotent", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    repo.seedFollow(A, B)

    const first = await service.unfollowPerson(A, B)
    expect(first).toEqual({ isFollowing: false, followers: 0 })

    const second = await service.unfollowPerson(A, B)
    expect(second).toEqual({ isFollowing: false, followers: 0 })
  })

  it("404s unfollowing a non-existent person", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    await expect(service.unfollowPerson(A, B)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("does not fire a notification on unfollow", async () => {
    const { repo, notifier, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    repo.seedFollow(A, B)
    await service.unfollowPerson(A, B)
    expect(notifier.calls).toHaveLength(0)
  })
})


describe("getProfile", () => {
  it("returns followers/following, isFollowing, stats, and recent-first pastEvents", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice", handle: "alice", bio: "organizer" })
    repo.seedUser({ id: B, displayName: "Bob" })
    repo.seedUser({ id: C, displayName: "Carol" })
    repo.seedFollow(B, A)
    repo.seedFollow(C, A)
    repo.seedFollow(A, B)
    repo.seedReports(A, 4)

    const older = makeCleanupRecord({
      organizerUserId: A,
      title: "Older",
      scheduledAt: new Date("2025-01-01T10:00:00.000Z"),
    })
    const newer = makeCleanupRecord({
      organizerUserId: A,
      title: "Newer",
      scheduledAt: new Date("2025-03-01T10:00:00.000Z"),
    })
    repo.seedCleanup(older)
    repo.seedCleanup(newer)

    const { profile } = await service.getProfile(A, { userId: C })
    expect(profile.id).toBe(A)
    expect(profile.name).toBe("Alice")
    expect(profile.followers).toBe(2)
    expect(profile.following).toBe(1)
    expect(profile.isFollowing).toBe(true)
    expect(profile.stats).toEqual({ reports: 4, cleanups: 2 })
    expect(profile.pastEvents.map((e) => e.title)).toEqual(["Newer", "Older"])
    expect(profile.avatar).toEqual(avatarGradient(A))
    expect(profile.pastEvents[0]!.joined).toBe(true)
    expect(profile.pastEvents[0]!.organizer.id).toBe(A)
  })

  it("isFollowing is false for an anonymous viewer", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    const { profile } = await service.getProfile(A, { userId: null })
    expect(profile.isFollowing).toBe(false)
  })

  it("404s a missing or soft-deleted profile", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Gone", deletedAt: new Date() })
    await expect(service.getProfile(A, { userId: null })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(service.getProfile(B, { userId: null })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("includes cleanups the user only ATTENDED (not just organized) in pastEvents", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    const event = makeCleanupRecord({ organizerUserId: B, title: "Bob's sweep" })
    repo.seedCleanup(event, [A])

    const { profile } = await service.getProfile(A, { userId: null })
    expect(profile.pastEvents.map((e) => e.title)).toContain("Bob's sweep")
    expect(profile.stats.cleanups).toBe(0)
  })

  it("falls back to the provider avatar_url on the full profile when no custom avatar was uploaded", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice", avatarUrl: "https://cdn.example.test/alice.jpg" })
    const { profile } = await service.getProfile(A, { userId: null })
    expect(profile.avatarUrl).toBe("https://cdn.example.test/alice.jpg")
  })

  it("omits avatarUrl on the full profile only when neither an uploaded nor a provider photo exists", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    const { profile } = await service.getProfile(A, { userId: null })
    expect(profile.avatarUrl).toBeUndefined()
  })
})

describe("getMyProfile", () => {
  it("returns the caller's own profile with isFollowing false", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    repo.seedFollow(B, A)
    const { profile } = await service.getMyProfile(A)
    expect(profile.id).toBe(A)
    expect(profile.followers).toBe(1)
    expect(profile.isFollowing).toBe(false)
  })
})

describe("resolveHandleToId", () => {
  it("resolves a handle to the user's id (case-insensitive)", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice", handle: "alice" })
    expect(await service.resolveHandleToId("Alice")).toBe(A)
  })

  it("404s an unknown handle", async () => {
    const { service } = makeHarness()
    await expect(service.resolveHandleToId("nobody_here")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })
})

describe("followSuggestions", () => {
  const D = "44444444-4444-4444-4444-444444444444"
  const E = "55555555-5555-5555-5555-555555555555"

  // Santa Monica-ish viewer point; "far" = New York.
  const NEAR = { lat: 34.01, lng: -118.49 }
  const FAR = { lat: 40.7, lng: -74.0 }

  it("ranks nearby organizers first, then nearby people, then organizers elsewhere, then the rest", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Viewer", handle: "viewer" })
    repo.seedUser({ id: B, displayName: "Nearby organizer", handle: "org_near" })
    repo.seedUser({ id: C, displayName: "Far organizer", handle: "org_far" })
    repo.seedUser({ id: D, displayName: "Nearby neighbor", handle: "neighbor" })
    repo.seedUser({ id: E, displayName: "Random person", handle: "random" })
    // The viewer's area: they attended B's cleanup at NEAR. C hosts an event far away. D and E have
    // no activity signal at all (no known location, not organizers) so they land in the last tier.
    repo.seedCleanup(makeCleanupRecord({ organizerUserId: B, ...NEAR }), [A])
    repo.seedCleanup(makeCleanupRecord({ organizerUserId: C, ...FAR }))

    const { results } = await service.followSuggestions(A, 10)
    const ids = results.map((r) => r.id)
    expect(ids[0]).toBe(B) // nearby organizer first
    expect(ids).toContain(C)
    expect(ids.indexOf(B)).toBeLessThan(ids.indexOf(C)) // nearby organizer beats far organizer
    expect(ids.indexOf(C)).toBeLessThan(ids.indexOf(E)) // organizer beats no-signal person
    expect(ids).not.toContain(A) // never self
  })

  it("excludes already-followed and blocked users, and returns isFollowing=false rows", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Viewer", handle: "viewer" })
    repo.seedUser({ id: B, displayName: "Followed", handle: "followed" })
    repo.seedUser({ id: C, displayName: "Blocked", handle: "blocked" })
    repo.seedUser({ id: D, displayName: "Fresh", handle: "fresh" })
    repo.seedFollow(A, B)
    repo.seedBlock(C, A)
    const { results } = await service.followSuggestions(A, 10)
    const ids = results.map((r) => r.id)
    expect(ids).toContain(D)
    expect(ids).not.toContain(B)
    expect(ids).not.toContain(C)
    for (const r of results) expect(r.isFollowing).toBe(false)
  })

  it("excludes handle-less and deleted users and respects the limit", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Viewer", handle: "viewer" })
    repo.seedUser({ id: B, displayName: "No handle" }) // handle defaults to null
    repo.seedUser({ id: C, displayName: "Deleted", handle: "gone", deletedAt: new Date() })
    repo.seedUser({ id: D, displayName: "One", handle: "one" })
    repo.seedUser({ id: E, displayName: "Two", handle: "two" })
    const { results } = await service.followSuggestions(A, 1)
    expect(results).toHaveLength(1)
    const all = await service.followSuggestions(A, 10)
    const ids = all.results.map((r) => r.id)
    expect(ids).not.toContain(B)
    expect(ids).not.toContain(C)
  })

  it("with no viewer location, organizers still rank above non-organizers", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Viewer", handle: "viewer" })
    repo.seedUser({ id: B, displayName: "Organizer", handle: "org" })
    repo.seedUser({ id: C, displayName: "Popular", handle: "pop" })
    repo.seedUser({ id: D, displayName: "Fan", handle: "fan" })
    repo.seedCleanup(makeCleanupRecord({ organizerUserId: B, ...FAR }))
    repo.seedFollow(D, C) // C has a follower, but B is an organizer
    const { results } = await service.followSuggestions(A, 10)
    const ids = results.map((r) => r.id)
    expect(ids.indexOf(B)).toBeLessThan(ids.indexOf(C))
    expect(ids.indexOf(C)).toBeLessThan(ids.indexOf(D)) // follower count breaks the tie in the last tier
  })
})
