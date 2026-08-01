/**
 * The group roster's PURE row -> view mapper (`toMemberView`), where every privacy rule for the
 * roster lives: tombstoning a soft-deleted user, masking a blocked pair behind the shared hidden
 * identity, and never loading follower counts.
 *
 * These exist because the mapper had ONE field out of step with the rest: `verified` was gated on the
 * blocked-pair check alone, so a soft-deleted user rendered as "Deleted User" with no handle, no bio
 * and no avatar - but still carrying a verified badge. It was found while writing the report-chat
 * roster's twin mapper, whose equivalent test failed on exactly this case.
 *
 * No database needed: the mapper takes a plain row.
 */

import { describe, expect, it } from "vitest"
import {
  toMemberView,
  type MemberRowSelect,
} from "../../src/services/chat-group-repository.drizzle.js"

/** A live, unremarkable member row; each test overrides only the field under inspection. */
function row(over: Partial<MemberRowSelect> = {}): MemberRowSelect {
  return {
    user_id: "22222222-2222-4222-8222-222222222222",
    role: "member",
    joined_at: new Date("2026-07-31T00:00:00.000Z"),
    display_name: "Grace Hopper",
    handle: "grace",
    bio: "finds bugs",
    avatar_url: "https://cdn.example/grace.jpg",
    user_deleted_at: null,
    verified: true,
    is_following: true,
    blocked_pair: false,
    ...over,
  }
}

describe("toMemberView", () => {
  it("maps a live member, badge and all", () => {
    const view = toMemberView(row())

    expect(view.role).toBe("member")
    expect(view.user.name).toBe("Grace Hopper")
    expect(view.user.handle).toBe("grace")
    expect(view.user.bio).toBe("finds bugs")
    expect(view.user.verified).toBe(true)
    expect(view.user.isFollowing).toBe(true)
    expect(view.user.deleted).toBeUndefined()
  })

  it("never reports follower counts - the roster does not load them", () => {
    const view = toMemberView(row())
    expect(view.user.followers).toBe(0)
    expect(view.user.following).toBe(0)
  })

  it("tombstones a soft-deleted user: no handle, bio, avatar URL OR verified badge", () => {
    // The verified assertion is the regression guard: every other field here already dropped, which
    // is what made the surviving badge a leak rather than a harmless inconsistency.
    const view = toMemberView(row({ user_deleted_at: new Date("2026-07-01T00:00:00.000Z") }))

    expect(view.user.deleted).toBe(true)
    expect(view.user.handle).toBeNull()
    expect(view.user.bio).toBeNull()
    expect(view.user.avatarUrl).toBeUndefined()
    expect(view.user.verified).toBeUndefined()
  })

  it("hides a blocked pair behind the shared hidden identity", () => {
    const view = toMemberView(row({ blocked_pair: true }))

    expect(view.user.name).not.toBe("Grace Hopper")
    expect(view.user.handle).toBeNull()
    expect(view.user.bio).toBeNull()
    expect(view.user.avatarUrl).toBeUndefined()
    expect(view.user.verified).toBeUndefined()
    // Hidden is NOT deleted: the account exists, this viewer just may not see it.
    expect(view.user.deleted).toBeUndefined()
  })

  it("prefers the DELETED tombstone over the blocked-pair mask when a row is both", () => {
    const view = toMemberView(
      row({ blocked_pair: true, user_deleted_at: new Date("2026-07-01T00:00:00.000Z") }),
    )
    expect(view.user.deleted).toBe(true)
    expect(view.user.verified).toBeUndefined()
  })

  it("keeps an unverified live member unbadged", () => {
    expect(toMemberView(row({ verified: false })).user.verified).toBeUndefined()
  })

  it("carries owner and admin roles through for the roster's role labels", () => {
    expect(toMemberView(row({ role: "owner" })).role).toBe("owner")
    expect(toMemberView(row({ role: "admin" })).role).toBe("admin")
  })
})
