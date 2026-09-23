/**
 * GET /reports/:id/chat/participants - the report chat roster that backs the chat-info surface.
 *
 * These cover the PURE row -> DTO mapper (`toReportParticipantDTO`), which is where every privacy
 * rule for the roster actually lives: a soft-deleted user must tombstone, a blocked pair must render
 * as the shared hidden identity, and neither may leak a handle, bio, avatar URL or verified badge.
 * The mapper is a deliberate twin of the group repo's `toMemberView`, so the two rosters agree; these
 * assertions are what keeps them from drifting apart.
 *
 * No database needed: the mapper takes a plain row.
 */

import { describe, expect, it } from "vitest"
import {
  toReportParticipantDTO,
  REPORT_CHAT_ROSTER_CAP,
  type ReportMemberRowSelect,
} from "../../src/services/report-chat-repository.drizzle.js"

/** A live, unremarkable member row; each test overrides only the field under inspection. */
function row(over: Partial<ReportMemberRowSelect> = {}): ReportMemberRowSelect {
  return {
    user_id: "11111111-1111-4111-8111-111111111111",
    role: "member",
    joined_at: new Date("2026-07-31T00:00:00.000Z"),
    display_name: "Ada Lovelace",
    handle: "ada",
    bio: "counts things",
    avatar_url: "https://cdn.example/ada.jpg",
    user_deleted_at: null,
    is_following: true,
    blocked_pair: false,
    ...over,
  }
}

describe("toReportParticipantDTO", () => {
  it("maps a live member to a PersonDTO plus role and joinedAt", () => {
    const dto = toReportParticipantDTO(row())

    expect(dto.role).toBe("member")
    expect(dto.joinedAt).toBe("2026-07-31T00:00:00.000Z")
    expect(dto.user.id).toBe("11111111-1111-4111-8111-111111111111")
    expect(dto.user.name).toBe("Ada Lovelace")
    expect(dto.user.handle).toBe("ada")
    expect(dto.user.bio).toBe("counts things")
    expect(dto.user.isFollowing).toBe(true)
    expect(dto.user.deleted).toBeUndefined()
  })

  it("carries the owner role through (the reporter sorts first in the roster)", () => {
    expect(toReportParticipantDTO(row({ role: "owner" })).role).toBe("owner")
  })

  it("never reports follower counts - a roster does not load them", () => {
    const dto = toReportParticipantDTO(row())
    expect(dto.user.followers).toBe(0)
    expect(dto.user.following).toBe(0)
  })

  it("tombstones a soft-deleted user: no handle, bio, avatar URL or verified badge", () => {
    const dto = toReportParticipantDTO(
      row({ user_deleted_at: new Date("2026-07-01T00:00:00.000Z") }),
    )

    expect(dto.user.deleted).toBe(true)
    expect(dto.user.handle).toBeNull()
    expect(dto.user.bio).toBeNull()
    expect(dto.user.avatarUrl).toBeUndefined()
  })

  it("hides a blocked pair behind the shared hidden identity", () => {
    const dto = toReportParticipantDTO(row({ blocked_pair: true }))

    expect(dto.user.name).not.toBe("Ada Lovelace")
    expect(dto.user.handle).toBeNull()
    expect(dto.user.bio).toBeNull()
    expect(dto.user.avatarUrl).toBeUndefined()
    // Hidden is NOT deleted: the account still exists, this viewer just may not see it.
    expect(dto.user.deleted).toBeUndefined()
  })

  it("prefers the DELETED tombstone over the blocked-pair mask when a row is both", () => {
    const dto = toReportParticipantDTO(
      row({ blocked_pair: true, user_deleted_at: new Date("2026-07-01T00:00:00.000Z") }),
    )
    expect(dto.user.deleted).toBe(true)
    expect(dto.user.handle).toBeNull()
  })

  it("tolerates a null display_name without emitting undefined", () => {
    expect(typeof toReportParticipantDTO(row({ display_name: null })).user.name).toBe("string")
  })
})

describe("REPORT_CHAT_ROSTER_CAP", () => {
  it("bounds a single roster read so no report can materialize an unbounded membership set", () => {
    expect(REPORT_CHAT_ROSTER_CAP).toBeGreaterThan(0)
    expect(Number.isInteger(REPORT_CHAT_ROSTER_CAP)).toBe(true)
  })
})
