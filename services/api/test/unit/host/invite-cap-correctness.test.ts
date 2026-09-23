import { describe, expect, it } from "vitest"
import { MAX_ORG_INVITES_PER_ORG, MAX_TEAM_INVITES_PER_EVENT } from "@civfix/shared"
import { makeDrizzleHostTeamRepository } from "../../../src/services/host/host-team-repository.drizzle.js"
import { makeDrizzleOrganizationRepository } from "../../../src/services/host/organization-repository.drizzle.js"
import { makeFakeSql, type FakeSqlControl } from "../../helpers/fake-sql.js"
import type { Sql } from "../../../src/db/client.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const HOST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const INVITE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const NOW = new Date("2026-01-01T12:00:00.000Z")
const LATER = new Date("2026-01-15T12:00:00.000Z")

function indexOf(fake: FakeSqlControl, pattern: RegExp): number {
  return fake.statements.findIndex((s) => pattern.test(s.sql))
}

describe("the open-invite cap is enforced inside the invite transaction", () => {
  it("refuses an event team invite once the cap is reached, counted under a per-event lock", async () => {
    const fake = makeFakeSql([
      { match: /AS closed\s+FROM cleanups/, rows: [{ closed: false }] },
      {
        match: /SELECT count\(\*\)::int AS count FROM cleanup_team_invites/,
        rows: [{ count: MAX_TEAM_INVITES_PER_EVENT }],
      },
    ])

    const invite = makeDrizzleHostTeamRepository(fake.sql as unknown as Sql).createInviteTx({
      inviteId: INVITE,
      cleanupId: EVENT,
      invitedUserId: null,
      invitedEmail: "new@example.org",
      role: "staff",
      tokenHash: "hash",
      invitedBy: HOST,
      expiresAt: LATER,
      now: NOW,
    })

    await expect(invite).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This event already has the maximum number of open invitations.",
    })
    const lock = indexOf(fake, /pg_advisory_xact_lock/)
    const count = indexOf(fake, /FROM cleanup_team_invites\s+WHERE cleanup_id = \? AND status/)
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(lock).toBeLessThan(count)
    expect(indexOf(fake, /INSERT INTO cleanup_team_invites/)).toBe(-1)
  })

  it("refuses an organization invite once the cap is reached, counted under a per-org lock", async () => {
    const fake = makeFakeSql([
      { match: /SELECT role FROM organization_members/, rows: [{ role: "owner" }] },
      {
        match: /SELECT count\(\*\)::int AS count FROM organization_invites/,
        rows: [{ count: MAX_ORG_INVITES_PER_ORG }],
      },
    ])

    const invite = makeDrizzleOrganizationRepository(fake.sql as unknown as Sql).createInviteTx({
      inviteId: INVITE,
      organizationId: ORG,
      email: "new@example.org",
      userId: null,
      role: "member",
      tokenHash: "hash",
      invitedBy: HOST,
      expiresAt: LATER,
      now: NOW,
    })

    await expect(invite).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This organization already has the maximum number of open invitations.",
    })
    const lock = indexOf(fake, /FROM organizations WHERE id = \? LIMIT 1 FOR UPDATE/)
    const count = indexOf(fake, /count\(\*\)::int AS count FROM organization_invites/)
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(lock).toBeLessThan(count)
    expect(indexOf(fake, /INSERT INTO organization_invites/)).toBe(-1)
  })
})
