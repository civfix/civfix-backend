/**
 * Host-plane lists page on timestamps Postgres stamps with now(), which carry microseconds. A cursor
 * built from the millisecond Date postgres.js returns, and bound back as a Date, skips (DESC) or repeats
 * (ASC) every row sharing the anchor's millisecond. These lists must carry the column's microsecond text.
 */

import { describe, expect, it } from "vitest"
import { makeFakeSql, type FakeSqlControl, type SqlHandler } from "../../helpers/fake-sql.js"
import type { Sql } from "../../../src/db/client.js"
import { makeDrizzleHostTeamRepository } from "../../../src/services/host/host-team-repository.drizzle.js"
import { makeDrizzleOrganizationRepository } from "../../../src/services/host/organization-repository.drizzle.js"
import { makeDrizzleHostRegistrationRepository } from "../../../src/services/host/registration-repository.drizzle.js"
import type { RosterQuery } from "../../../src/services/host/registration-repository.js"

const AT = new Date("2026-09-01T10:00:00.123Z")
const AT_TEXT = "2026-09-01T10:00:00.123456Z"
const LEGACY_AT_TEXT = "2026-09-01T10:00:00.123Z"
const CHECKED_IN_TEXT = "2026-09-02T08:30:00.654321Z"
const ID_A = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e01"
const ID_B = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e02"
const EVENT = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e0e"
const ORG = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e0a"
const USER = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e0b"
const NEXT = `${AT_TEXT}|${ID_A}`
const LEGACY = `${LEGACY_AT_TEXT}|${ID_A}`

function twoRows(extra: Record<string, unknown>, idKey = "id"): Record<string, unknown>[] {
  return [
    { ...extra, [idKey]: ID_A, cursor_at: AT_TEXT },
    { ...extra, [idKey]: ID_B, cursor_at: "2026-09-01T10:00:00.123001Z" },
  ]
}

function lastStatement(ctl: FakeSqlControl, match: RegExp): { sql: string; values: unknown[] } {
  const hit = [...ctl.statements].reverse().find((s) => match.test(s.sql))
  if (hit === undefined) throw new Error(`no statement matched ${String(match)}`)
  return hit
}

function expectExactAnchor(ctl: FakeSqlControl, match: RegExp, atText = AT_TEXT): void {
  const stmt = lastStatement(ctl, match)
  expect(stmt.sql).toMatch(/to_char\([\s\S]* AT TIME ZONE 'UTC', \?\) AS cursor_at/)
  expect(stmt.values).toContain(atText)
  expect(stmt.values.some((v) => v instanceof Date && v.getTime() === AT.getTime())).toBe(false)
  expect(stmt.sql).toContain("?::timestamptz")
}

function fake(match: RegExp, rows: Record<string, unknown>[]): FakeSqlControl {
  const handlers: SqlHandler[] = [{ match, rows }]
  return makeFakeSql(handlers)
}

describe("event team invites for the invitee", () => {
  const LIST = /FROM cleanup_team_invites i/
  const invite = {
    role: "cohost",
    created_at: AT,
    expires_at: new Date("2026-09-08T10:00:00Z"),
    event_id: EVENT,
    title: "Beach Cleanup",
    scheduled_at: new Date("2026-09-10T10:00:00Z"),
    ends_at: null,
    event_status: "upcoming",
    visibility: "public",
    address: null,
    cover_key: null,
    inviter_id: null,
    inviter_name: null,
    inviter_handle: null,
    inviter_avatar_url: null,
  }

  async function list(ctl: FakeSqlControl, cursor: string | null) {
    return makeDrizzleHostTeamRepository(ctl.sql as unknown as Sql).listInvitesForUser({
      userId: USER,
      now: new Date("2026-09-01T12:00:00Z"),
      cursor,
      limit: 1,
    })
  }

  it("encodes the microsecond instant and binds it back as text", async () => {
    const ctl = fake(LIST, twoRows(invite))
    expect((await list(ctl, null)).nextCursor).toBe(NEXT)
    await list(ctl, NEXT)
    expectExactAnchor(ctl, LIST)
  })

  it("still accepts a legacy millisecond cursor as the same instant", async () => {
    const ctl = fake(LIST, [])
    await list(ctl, LEGACY)
    expectExactAnchor(ctl, LIST, LEGACY_AT_TEXT)
  })
})

describe("organization member lists", () => {
  const MEMBERS = /FROM organization_members m/
  const member = {
    display_name: "Ada",
    handle: "ada",
    bio: null,
    avatar_url: null,
    created_at: AT,
    role: "member",
    joined_at: AT,
  }

  function repo(ctl: FakeSqlControl) {
    return makeDrizzleOrganizationRepository(ctl.sql as unknown as Sql)
  }

  it("encodes the member list's microsecond join instant and binds it back as text", async () => {
    const ctl = fake(MEMBERS, twoRows(member, "user_id"))
    const first = await repo(ctl).listMembers({ organizationId: ORG, cursor: null, limit: 1 })
    expect(first.nextCursor).toBe(NEXT)
    await repo(ctl).listMembers({ organizationId: ORG, cursor: NEXT, limit: 1 })
    expectExactAnchor(ctl, MEMBERS)
    expect(lastStatement(ctl, MEMBERS).sql).toMatch(
      /\(m\.joined_at, m\.user_id\) > \(\?::timestamptz, \?::uuid\)/,
    )
  })

  it("encodes the operator member list's microsecond join instant and binds it back as text", async () => {
    const ctl = fake(MEMBERS, twoRows(member, "user_id"))
    const first = await repo(ctl).adminListMembers({ organizationId: ORG, cursor: null, limit: 1 })
    expect(first.nextCursor).toBe(NEXT)
    await repo(ctl).adminListMembers({ organizationId: ORG, cursor: NEXT, limit: 1 })
    expectExactAnchor(ctl, MEMBERS)
  })

  it("still accepts a legacy millisecond member cursor as the same instant", async () => {
    const ctl = fake(MEMBERS, [])
    await repo(ctl).listMembers({ organizationId: ORG, cursor: LEGACY, limit: 1 })
    expectExactAnchor(ctl, MEMBERS, LEGACY_AT_TEXT)
  })
})

describe("operator organization list", () => {
  const LIST = /ORDER BY o\.created_at DESC, o\.id DESC/
  const org = {
    slug: "beach-friends",
    name: "Beach Friends",
    description: null,
    website_url: null,
    donation_url: null,
    logo_media_id: null,
    logo_key: null,
    social_links: {},
    verified_status: "unverified",
    verified_kind: null,
    verified_at: null,
    created_by: USER,
    created_at: AT,
    updated_at: AT,
    deleted_at: null,
    suspended_at: null,
    suspended_reason: null,
    member_count: 1,
    event_count: 0,
    my_role: null,
    owner_id: null,
    owner_name: null,
    owner_handle: null,
    owner_joined: null,
  }

  it("encodes the microsecond instant and binds it back as text", async () => {
    const ctl = fake(LIST, twoRows(org))
    const repo = makeDrizzleOrganizationRepository(ctl.sql as unknown as Sql)
    const first = await repo.adminListOrganizations({ cursor: null, limit: 1 })
    expect(first.nextCursor).toBe(NEXT)
    await repo.adminListOrganizations({ cursor: NEXT, limit: 1 })
    expectExactAnchor(ctl, LIST)
  })
})

describe("event waitlist", () => {
  const LIST = /FROM cleanup_waitlist w/
  const entry = {
    cleanup_id: EVENT,
    ticket_type_id: ID_B,
    ticket_type_name: "General",
    user_id: null,
    guest_id: ID_B,
    guest_name: "Pat",
    party_size: 1,
    status: "waiting",
    position: 1,
    created_at: AT,
    offered_at: null,
    claim_expires_at: null,
    person_display_name: null,
    person_handle: null,
    person_bio: null,
    person_avatar_url: null,
    person_deleted_at: null,
  }

  async function list(ctl: FakeSqlControl, cursor: string | null) {
    return makeDrizzleHostRegistrationRepository(ctl.sql as unknown as Sql).listWaitlist({
      cleanupId: EVENT,
      ticketTypeId: null,
      status: null,
      cursor,
      limit: 1,
    })
  }

  it("encodes the microsecond instant and binds it back as text", async () => {
    const ctl = fake(LIST, twoRows(entry))
    expect((await list(ctl, null)).nextCursor).toBe(NEXT)
    await list(ctl, NEXT)
    expectExactAnchor(ctl, LIST)
    expect(lastStatement(ctl, LIST).sql).toMatch(
      /\(w\.created_at, w\.id\) > \(\?::timestamptz, \?::uuid\)/,
    )
  })
})

describe("host roster", () => {
  const ROSTER = /FROM cleanup_registrations r\b[\s\S]*ORDER BY/

  function rosterRow(id: string, cursorAt: string): Record<string, unknown> {
    return {
      id,
      cleanup_id: EVENT,
      user_id: null,
      guest_id: ID_B,
      registered_at: AT,
      checked_in_at: null,
      cursor_at: cursorAt,
      checked_in_cursor_at: CHECKED_IN_TEXT,
    }
  }

  function query(sort: RosterQuery["sort"], cursor: string | null): RosterQuery {
    return {
      cleanupId: EVENT,
      filter: "all",
      ticketTypeId: null,
      slotId: null,
      sort,
      q: null,
      cursor,
      limit: 1,
      withTotal: false,
    }
  }

  function roster(ctl: FakeSqlControl) {
    return makeDrizzleHostRegistrationRepository(ctl.sql as unknown as Sql)
  }

  const rows = [rosterRow(ID_A, AT_TEXT), rosterRow(ID_B, "2026-09-01T10:00:00.123001Z")]

  it("pages the registered_at sorts on the microsecond instant", async () => {
    for (const sort of ["registered_at_desc", "registered_at_asc"] as const) {
      const ctl = fake(ROSTER, rows)
      expect((await roster(ctl).listRoster(query(sort, null))).nextCursor).toBe(NEXT)
      await roster(ctl).listRoster(query(sort, NEXT))
      expectExactAnchor(ctl, ROSTER)
    }
  })

  it("carries both microsecond instants in the checked-in cursor and binds them as text", async () => {
    const ctl = fake(ROSTER, rows)
    const first = await roster(ctl).listRoster(query("checked_in_at_desc", null))
    const next = `${CHECKED_IN_TEXT}|${AT_TEXT}|${ID_A}`
    expect(first.nextCursor).toBe(next)

    await roster(ctl).listRoster(query("checked_in_at_desc", next))
    const stmt = lastStatement(ctl, ROSTER)
    expect(stmt.sql).toMatch(
      /'epoch'::timestamptz\), r\.registered_at, r\.id\) < \(\?::timestamptz, \?::timestamptz, \?::uuid\)/,
    )
    expect(stmt.values).toEqual(expect.arrayContaining([CHECKED_IN_TEXT, AT_TEXT, ID_A]))
    expect(stmt.values.some((v) => v instanceof Date)).toBe(false)
  })

  it("still decodes a checked-in cursor minted with millisecond instants", async () => {
    const ctl = fake(ROSTER, [])
    const legacy = `2026-09-02T08:30:00.654Z|${LEGACY_AT_TEXT}|${ID_A}`
    await roster(ctl).listRoster(query("checked_in_at_desc", legacy))
    const stmt = lastStatement(ctl, ROSTER)
    expect(stmt.values).toEqual(
      expect.arrayContaining(["2026-09-02T08:30:00.654Z", LEGACY_AT_TEXT, ID_A]),
    )
  })
})
