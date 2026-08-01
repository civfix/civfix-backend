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
  toPersonView,
  type PersonRowSelect,
} from "../../src/services/social-repository.drizzle.js"
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
      showVolunteerHours: null,
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
      showVolunteerHours: null,
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

  // M-people-blocks: the block filter on people SEARCH is symmetric — a block hides both accounts from
  // each other's search results, in whichever direction it was created.
  it("excludes an account the viewer blocked", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    repo.seedUser({ id: C, displayName: "Carol" })
    repo.seedBlock(A, B)

    const res = await service.listPeople({ limit: 20 }, { userId: A })
    const ids = res.items.map((p) => p.id)
    expect(ids).not.toContain(B)
    expect(ids).toContain(C)
  })

  it("excludes an account that blocked the viewer (other direction)", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    repo.seedBlock(B, A)

    const asA = await service.listPeople({ limit: 20 }, { userId: A })
    expect(asA.items.map((p) => p.id)).not.toContain(B)
    // ...and the block hides the blocker from the blocked user too.
    const asB = await service.listPeople({ limit: 20 }, { userId: B })
    expect(asB.items.map((p) => p.id)).not.toContain(A)
  })

  it("keeps blocked accounts visible to an ANONYMOUS viewer (no viewer, no block rows)", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    repo.seedBlock(A, B)

    const res = await service.listPeople({ limit: 20 }, { userId: null })
    expect(res.items.map((p) => p.id).sort()).toEqual([A, B].sort())
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
    repo.seedReports(A, 4, 3)

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
    expect(profile.stats).toEqual({ reports: 4, fixed: 3, cleanups: 2 })
    expect(profile.pastEvents.map((e) => e.title)).toEqual(["Newer", "Older"])
    expect(profile.avatar).toEqual(avatarGradient(A))
    // `joined` is the VIEWER's membership, not the profile owner's: C is looking at A's events, so the
    // cards must not claim C is attending them (and myRole stays omitted). See the next test for the
    // owner's own view, where every card IS genuinely joined.
    expect(profile.pastEvents[0]!.joined).toBe(false)
    expect(profile.pastEvents[0]!.myRole).toBeUndefined()
    expect(profile.pastEvents[0]!.organizer.id).toBe(A)
  })

  it("pastEvents are joined only on the OWNER's own view, never for another or anonymous viewer", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    repo.seedCleanup(makeCleanupRecord({ organizerUserId: A, title: "Organized" }))
    repo.seedCleanup(makeCleanupRecord({ organizerUserId: B, title: "Attended" }), [A])

    // A's own profile: every card is an event A organized or attended, so `joined` is true for all.
    const own = await service.getProfile(A, { userId: A })
    expect(own.profile.pastEvents).toHaveLength(2)
    expect(own.profile.pastEvents.map((e) => e.joined)).toEqual([true, true])

    // C (and an anonymous viewer) has no membership in A's events, so none of the cards are joined.
    const other = await service.getProfile(A, { userId: C })
    expect(other.profile.pastEvents.map((e) => e.joined)).toEqual([false, false])
    expect(other.profile.pastEvents.map((e) => e.myRole)).toEqual([undefined, undefined])

    const anon = await service.getProfile(A, { userId: null })
    expect(anon.profile.pastEvents.map((e) => e.joined)).toEqual([false, false])
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

/**
 * P6 hours privacy — `users.show_volunteer_hours` is a NULLABLE TRI-STATE (C18), not a boolean, and the
 * profile has to keep all three arms apart:
 *   null  = never chosen  -> hours visible, flag ABSENT (the response every existing account already gets)
 *   true  = explicit opt-in  -> hours visible, flag true
 *   false = explicit opt-out -> hours OMITTED, flag false
 * The (omitted hours + `showVolunteerHours: false`) PAIR is load-bearing: without the flag a hidden
 * profile is indistinguishable from someone who genuinely has no hours yet, and emitting `0` would be a
 * lie. `in` rather than `=== undefined` throughout, because "absent from the payload" is the actual
 * contract — a present-but-undefined key would serialize differently.
 */
describe("getProfile: volunteer-hours privacy tri-state (C18)", () => {
  const HOURS = 12.5

  function makeHoursHarness(): {
    repo: InMemorySocialRepository
    service: SocialService
    /** Every userId `volunteerHoursTotalFor` was asked about — empty means the query never ran. */
    calls: string[]
  } {
    const repo = new InMemorySocialRepository()
    const calls: string[] = []
    const service = makeSocialService({
      repo,
      volunteerHoursTotalFor: (userId: string) => {
        calls.push(userId)
        return Promise.resolve(HOURS)
      },
    })
    return { repo, service, calls }
  }

  it("NULL (never chosen): hours present, flag ABSENT — byte-identical to the pre-column response", async () => {
    const { repo, service, calls } = makeHoursHarness()
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: C, displayName: "Carol" })

    const { profile } = await service.getProfile(A, { userId: C })
    expect(profile.volunteerHours).toBe(HOURS)
    expect("showVolunteerHours" in profile).toBe(false)
    expect(calls).toEqual([A])
  })

  it("TRUE (explicit opt-in): hours present AND the flag emitted true", async () => {
    const { repo, service, calls } = makeHoursHarness()
    repo.seedUser({ id: A, displayName: "Alice", showVolunteerHours: true })
    repo.seedUser({ id: C, displayName: "Carol" })

    const { profile } = await service.getProfile(A, { userId: C })
    expect(profile.volunteerHours).toBe(HOURS)
    expect(profile.showVolunteerHours).toBe(true)
    expect(calls).toEqual([A])
  })

  it("FALSE (explicit opt-out) on ANOTHER user's profile: hours OMITTED, flag false, total never queried", async () => {
    const { repo, service, calls } = makeHoursHarness()
    repo.seedUser({ id: A, displayName: "Alice", showVolunteerHours: false })
    repo.seedUser({ id: C, displayName: "Carol" })

    const { profile } = await service.getProfile(A, { userId: C })
    expect("volunteerHours" in profile).toBe(false)
    expect(profile.showVolunteerHours).toBe(false)
    // Not merely stripped from the response — the read is skipped entirely.
    expect(calls).toEqual([])
  })

  it("an ANONYMOUS viewer is gated exactly like a signed-in stranger", async () => {
    const { repo, service, calls } = makeHoursHarness()
    repo.seedUser({ id: A, displayName: "Alice", showVolunteerHours: false })

    const { profile } = await service.getProfile(A, { userId: null })
    expect("volunteerHours" in profile).toBe(false)
    expect(profile.showVolunteerHours).toBe(false)
    expect(calls).toEqual([])
  })

  it("isSelf BYPASSES the flag: an opted-out user still sees their OWN hours, flag and all", async () => {
    const { repo, service, calls } = makeHoursHarness()
    repo.seedUser({ id: A, displayName: "Alice", showVolunteerHours: false })

    const own = await service.getProfile(A, { userId: A })
    expect(own.profile.volunteerHours).toBe(HOURS)
    // The RAW tri-state rides along so the settings toggle renders the honest position.
    expect(own.profile.showVolunteerHours).toBe(false)

    const mine = await service.getMyProfile(A)
    expect(mine.profile.volunteerHours).toBe(HOURS)
    expect(mine.profile.showVolunteerHours).toBe(false)
    expect(calls).toEqual([A, A])
  })

  it("isSelf with the flag never chosen still omits it (absent means 'never chosen' on your own DTO too)", async () => {
    const { repo, service } = makeHoursHarness()
    repo.seedUser({ id: A, displayName: "Alice" })

    const { profile } = await service.getMyProfile(A)
    expect(profile.volunteerHours).toBe(HOURS)
    expect("showVolunteerHours" in profile).toBe(false)
  })

  it("resolves the same three arms through getProfileByHandle", async () => {
    const { repo, service } = makeHoursHarness()
    repo.seedUser({ id: A, displayName: "Alice", handle: "alice", showVolunteerHours: false })
    repo.seedUser({ id: B, displayName: "Bob", handle: "bob", showVolunteerHours: true })

    const hidden = await service.getProfileByHandle("alice", { userId: C })
    expect("volunteerHours" in hidden.profile).toBe(false)
    expect(hidden.profile.showVolunteerHours).toBe(false)

    const shown = await service.getProfileByHandle("bob", { userId: C })
    expect(shown.profile.volunteerHours).toBe(HOURS)
    expect(shown.profile.showVolunteerHours).toBe(true)
  })

  it("with NO volunteerHoursTotalFor wired, an opted-in profile still carries the flag and no hours", async () => {
    const { repo, service } = makeHarness()
    repo.seedUser({ id: A, displayName: "Alice", showVolunteerHours: true })
    const { profile } = await service.getProfile(A, { userId: C })
    expect("volunteerHours" in profile).toBe(false)
    expect(profile.showVolunteerHours).toBe(true)
  })

  /**
   * FAIL-CLOSED on a projection that FORGOT the column.
   *
   * The four PersonView-producing reads in social-repository.drizzle.ts are raw postgres.js templates
   * typed by `sql<PersonRowSelect[]>` — an UNCHECKED assertion. A projection that drops
   * `u.show_volunteer_hours` therefore typechecks and yields `undefined` at runtime, and `undefined`
   * would sail through `view.showVolunteerHours === false`, publishing the hours of a user who
   * explicitly hid them. `toPersonView` coerces that `undefined` to an explicit opt-out.
   */
  describe("toPersonView: a projection missing show_volunteer_hours fails CLOSED", () => {
    /** Exactly what postgres.js hands back when the SELECT list omits the column: no such key. */
    function rowWithoutTheColumn(): PersonRowSelect {
      return {
        id: A,
        display_name: "Alice",
        handle: "alice",
        bio: null,
        followers: 0,
        following: 0,
        verified: false,
        avatar_r2_key: null,
        avatar_url: null,
        social_links: null,
      } as unknown as PersonRowSelect
    }

    it("maps a missing column to false (an explicit opt-out), not undefined", () => {
      const row = rowWithoutTheColumn()
      expect("show_volunteer_hours" in row).toBe(false)
      expect(toPersonView(row).showVolunteerHours).toBe(false)
    })

    it("still passes the real tri-state through verbatim — null must NOT collapse to false", () => {
      const nullArm = { ...rowWithoutTheColumn(), show_volunteer_hours: null } as PersonRowSelect
      const trueArm = { ...rowWithoutTheColumn(), show_volunteer_hours: true } as PersonRowSelect
      const falseArm = { ...rowWithoutTheColumn(), show_volunteer_hours: false } as PersonRowSelect
      expect(toPersonView(nullArm).showVolunteerHours).toBeNull()
      expect(toPersonView(trueArm).showVolunteerHours).toBe(true)
      expect(toPersonView(falseArm).showVolunteerHours).toBe(false)
    })

    it("end to end: the coerced view HIDES the hours instead of disclosing them", async () => {
      const { repo, service, calls } = makeHoursHarness()
      const view = toPersonView(rowWithoutTheColumn())
      repo.seedUser({ id: A, displayName: "Alice", showVolunteerHours: view.showVolunteerHours })
      repo.seedUser({ id: C, displayName: "Carol" })

      const { profile } = await service.getProfile(A, { userId: C })
      expect("volunteerHours" in profile).toBe(false)
      // ...and the total is never even queried, the same as a genuine opt-out.
      expect(calls).toEqual([])
    })
  })
})

describe("getProfile block gate (CVX-023)", () => {
  function makeBlockedService(edges: Array<{ blocker: string; blocked: string }>): {
    repo: InMemorySocialRepository
    service: SocialService
  } {
    const repo = new InMemorySocialRepository()
    const service = makeSocialService({
      repo,
      blockState: (viewerId, targetId) =>
        Promise.resolve({
          blockedByViewer: edges.some((e) => e.blocker === viewerId && e.blocked === targetId),
          blockedByTarget: edges.some((e) => e.blocker === targetId && e.blocked === viewerId),
        }),
    })
    return { repo, service }
  }

  it("returns a neutral shell with blockedByMe when the viewer blocked the target", async () => {
    const { repo, service } = makeBlockedService([{ blocker: A, blocked: B }])
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob", handle: "bob", bio: "hi", verified: true })
    repo.seedReports(B, 5, 2)
    repo.seedCleanup(makeCleanupRecord({ organizerUserId: B, title: "Past" }))

    const { profile } = await service.getProfile(B, { userId: A })
    expect(profile.blockedByMe).toBe(true)
    expect(profile.id).toBe(B)
    expect(profile.name).toBe("Bob")
    expect(profile.handle).toBe("bob")
    expect(profile.verified).toBe(true)
    expect(profile.bio).toBeNull()
    expect(profile.stats).toEqual({ reports: 0, fixed: 0, cleanups: 0 })
    expect(profile.pastEvents).toEqual([])
    expect(profile.followers).toBe(0)
    expect(profile.following).toBe(0)
    expect(profile.isFollowing).toBe(false)
    expect("volunteerHours" in profile).toBe(false)
    expect("showVolunteerHours" in profile).toBe(false)
  })

  it("404s when the target blocked the viewer (no oracle, no blockedByMe)", async () => {
    const { repo, service } = makeBlockedService([{ blocker: B, blocked: A }])
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    await expect(service.getProfile(B, { userId: A })).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("prefers the unblock shell when both directions are blocked", async () => {
    const { repo, service } = makeBlockedService([
      { blocker: A, blocked: B },
      { blocker: B, blocked: A },
    ])
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    const { profile } = await service.getProfile(B, { userId: A })
    expect(profile.blockedByMe).toBe(true)
  })

  it("returns the full profile with no blockedByMe when there is no block", async () => {
    const { repo, service } = makeBlockedService([])
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob", bio: "real bio" })
    repo.seedReports(B, 3, 1)
    const { profile } = await service.getProfile(B, { userId: A })
    expect("blockedByMe" in profile).toBe(false)
    expect(profile.bio).toBe("real bio")
    expect(profile.stats.reports).toBe(3)
  })

  it("gates getProfileByHandle the same way", async () => {
    const { repo, service } = makeBlockedService([{ blocker: A, blocked: B }])
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob", handle: "bob" })
    const { profile } = await service.getProfileByHandle("bob", { userId: A })
    expect(profile.blockedByMe).toBe(true)
    expect(profile.pastEvents).toEqual([])
  })

  it("never blocks the viewer from their OWN profile", async () => {
    const { repo, service } = makeBlockedService([{ blocker: A, blocked: A }])
    repo.seedUser({ id: A, displayName: "Alice", bio: "me" })
    const own = await service.getProfile(A, { userId: A })
    expect("blockedByMe" in own.profile).toBe(false)
    expect(own.profile.bio).toBe("me")
    const mine = await service.getMyProfile(A)
    expect("blockedByMe" in mine.profile).toBe(false)
  })

  it("does not consult the block state for an anonymous viewer", async () => {
    const repo = new InMemorySocialRepository()
    let consulted = false
    const service = makeSocialService({
      repo,
      blockState: () => {
        consulted = true
        return Promise.resolve({ blockedByViewer: false, blockedByTarget: false })
      },
    })
    repo.seedUser({ id: B, displayName: "Bob", bio: "hi" })
    const { profile } = await service.getProfile(B, { userId: null })
    expect(consulted).toBe(false)
    expect(profile.bio).toBe("hi")
    expect("blockedByMe" in profile).toBe(false)
  })
})

describe("followers/following block gate (CVX-023)", () => {
  function makeGatedService(edges: Array<{ blocker: string; blocked: string }>): {
    repo: InMemorySocialRepository
    service: SocialService
  } {
    const repo = new InMemorySocialRepository()
    const service = makeSocialService({
      repo,
      blockState: (viewerId, targetId) =>
        Promise.resolve({
          blockedByViewer: edges.some((e) => e.blocker === viewerId && e.blocked === targetId),
          blockedByTarget: edges.some((e) => e.blocker === targetId && e.blocked === viewerId),
        }),
    })
    return { repo, service }
  }

  function seedRoster(repo: InMemorySocialRepository): void {
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    repo.seedUser({ id: C, displayName: "Carol" })
    repo.seedFollow(C, B)
    repo.seedFollow(B, C)
  }

  it("404s followers with the profile's message when the target blocked the viewer", async () => {
    const { repo, service } = makeGatedService([{ blocker: B, blocked: A }])
    seedRoster(repo)
    await expect(service.listFollowers(B, { userId: A }, { id: B })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Person not found",
    })
  })

  it("404s following when the target blocked the viewer", async () => {
    const { repo, service } = makeGatedService([{ blocker: B, blocked: A }])
    seedRoster(repo)
    await expect(service.listFollowing(B, { userId: A }, { id: B })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Person not found",
    })
  })

  it("serves an empty page when the viewer blocked the target", async () => {
    const { repo, service } = makeGatedService([{ blocker: A, blocked: B }])
    seedRoster(repo)
    expect(await service.listFollowers(B, { userId: A }, { id: B })).toEqual({
      items: [],
      nextCursor: null,
    })
    expect(await service.listFollowing(B, { userId: A }, { id: B })).toEqual({
      items: [],
      nextCursor: null,
    })
  })

  it("prefers the empty page over the 404 when both directions are blocked", async () => {
    const { repo, service } = makeGatedService([
      { blocker: A, blocked: B },
      { blocker: B, blocked: A },
    ])
    seedRoster(repo)
    expect(await service.listFollowers(B, { userId: A }, { id: B })).toEqual({
      items: [],
      nextCursor: null,
    })
  })

  it("serves the real roster when there is no block", async () => {
    const { repo, service } = makeGatedService([])
    seedRoster(repo)
    const followers = await service.listFollowers(B, { userId: A }, { id: B })
    expect(followers.items.map((p) => p.id)).toEqual([C])
    const following = await service.listFollowing(B, { userId: A }, { id: B })
    expect(following.items.map((p) => p.id)).toEqual([C])
  })

  it("does not consult the block state for an anonymous viewer", async () => {
    const repo = new InMemorySocialRepository()
    let consulted = false
    const service = makeSocialService({
      repo,
      blockState: () => {
        consulted = true
        return Promise.resolve({ blockedByViewer: true, blockedByTarget: true })
      },
    })
    seedRoster(repo)
    const page = await service.listFollowers(B, { userId: null }, { id: B })
    expect(consulted).toBe(false)
    expect(page.items.map((p) => p.id)).toEqual([C])
  })

  it("404s unfollow when the target blocked the viewer, and leaks no follower count", async () => {
    const { repo, service } = makeGatedService([{ blocker: B, blocked: A }])
    seedRoster(repo)
    repo.seedFollow(A, B)
    await expect(service.unfollowPerson(A, B)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Person not found",
    })
  })

  it("still lets the viewer unfollow someone the viewer blocked", async () => {
    const { repo, service } = makeGatedService([{ blocker: A, blocked: B }])
    seedRoster(repo)
    repo.seedFollow(A, B)
    expect(await service.unfollowPerson(A, B)).toMatchObject({ isFollowing: false })
  })

  it("does not consult the block state for the owner's own roster", async () => {
    const repo = new InMemorySocialRepository()
    let consulted = false
    const service = makeSocialService({
      repo,
      blockState: () => {
        consulted = true
        return Promise.resolve({ blockedByViewer: true, blockedByTarget: true })
      },
    })
    seedRoster(repo)
    const page = await service.listFollowers(B, { userId: B }, { id: B })
    expect(consulted).toBe(false)
    expect(page.items.map((p) => p.id)).toEqual([C])
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
