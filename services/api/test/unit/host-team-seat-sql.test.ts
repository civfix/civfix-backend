import { describe, expect, it } from "vitest"
import { makeDrizzleHostTeamRepository } from "../../src/services/host/host-team-repository.drizzle.js"
import { makeSqlRecorder, type SqlRecorder } from "../helpers/sql-recorder.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const INVITE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const NOW = new Date("2026-03-04T05:06:07.000Z")
const SEAT = /^INSERT INTO cleanup_members/
const HELD_ROLE = /^SELECT role FROM cleanup_members/

// Answers the accept-by-id flow up to the seat: a pending, unexpired staff invite on an open event, no ban.
function acceptFlow(
  seated: { role: string }[],
  heldRoles: ({ role: string } | null)[],
): SqlRecorder {
  const rec = makeSqlRecorder()
  rec.on(/^SELECT cleanup_id, status FROM cleanup_team_invites/, [
    { cleanup_id: EVENT, status: "pending" },
  ])
  rec.on(/AS closed FROM cleanups/, [{ closed: false }])
  rec.on(/^SELECT id, role, status, expires_at FROM cleanup_team_invites/, [
    { id: INVITE, role: "staff", status: "pending", expires_at: new Date(NOW.getTime() + 60_000) },
  ])
  rec.on(SEAT, seated)
  rec.on(HELD_ROLE, () => {
    const next = heldRoles.shift()
    return next === null || next === undefined ? [] : [next]
  })
  rec.on(/^INSERT INTO audit_log/, [{ id: "audit-1" }])
  return rec
}

async function accept(rec: SqlRecorder) {
  return makeDrizzleHostTeamRepository(rec.sql).acceptInviteByIdTx({
    inviteId: INVITE,
    userId: USER,
    now: NOW,
  })
}

describe("seating an invited team member", () => {
  it("takes the seated role from the upsert without reading it back", async () => {
    const rec = acceptFlow([{ role: "cohost" }], [{ role: "cohost" }])

    const outcome = await accept(rec)

    expect(outcome).toEqual({ kind: "accepted", cleanupId: EVENT, role: "cohost" })
    const seat = rec.queries.find((q) => SEAT.test(q.text))
    expect(seat?.scope).toBe("tx1")
    expect(seat?.text).toMatch(/WHERE cleanup_members\.role <> 'organizer' RETURNING role$/)
    const statements = rec.queries.map((q) => q.text)
    const seatAt = statements.findIndex((t) => SEAT.test(t))
    expect(statements.filter((t) => HELD_ROLE.test(t))).toHaveLength(1)
    expect(statements.slice(seatAt + 1).some((t) => HELD_ROLE.test(t))).toBe(false)
  })

  it("seats a newcomer with the invite's role", async () => {
    const rec = acceptFlow([{ role: "staff" }], [null])

    expect(await accept(rec)).toEqual({ kind: "accepted", cleanupId: EVENT, role: "staff" })
    expect(rec.queries.filter((q) => HELD_ROLE.test(q.text))).toHaveLength(1)
  })

  it("reads the held role back when the organizer guard skipped the update", async () => {
    const rec = acceptFlow([], [{ role: "organizer" }, { role: "organizer" }])

    const outcome = await accept(rec)

    expect(outcome).toEqual({ kind: "accepted", cleanupId: EVENT, role: "organizer" })
    const statements = rec.queries.map((q) => q.text)
    const seatAt = statements.findIndex((t) => SEAT.test(t))
    expect(HELD_ROLE.test(statements[seatAt + 1] ?? "")).toBe(true)
    expect(rec.queries[seatAt + 1]?.params).toEqual([EVENT, USER])
  })
})
