import { describe, it, expect } from "vitest"
import { InMemoryAdminUserRepository } from "../../src/services/admin/admin-user-repository.memory.js"
import {
  makeAdminUserService,
  resolveUserFilter,
  type AdminUserService,
} from "../../src/services/admin/admin-user-service.js"
import { avatarGradient } from "@civfix/shared"

/**
 * Offline unit tests for the admin users service over the in-memory AdminUserRepository (no DB, no
 * Docker). They cover the list (status + flagged facet, search, pagination), the detail (role + derived
 * trust/status/counts), the three sub-activity lists (reports/events/messages, paginated), the flag
 * toggle (user_moderation + audit), setStatus (ban revokes sessions + sets account_status + audit) and
 * setRole (repo-atomic role+audit write, the H3 escalation guards, session revoke), plus the pure helper.
 */

const NOW = new Date("2026-06-06T00:00:00.000Z")

interface Harness {
  repo: InMemoryAdminUserRepository
  svc: AdminUserService
  /** Records of sessions.ban(userId) calls (H2). */
  banned: string[]
  /** Records of sessions.clearBan(userId) calls (H2). */
  cleared: string[]
  /** Records of sessions.revokeAll(userId) calls (H2). */
  revoked: string[]
}

function harness(): Harness {
  const repo = new InMemoryAdminUserRepository()
  const banned: string[] = []
  const cleared: string[] = []
  const revoked: string[] = []
  const svc = makeAdminUserService({
    repo,
    sessions: {
      ban: (userId) => {
        banned.push(userId)
        return Promise.resolve(1) // pretend 1 session revoked
      },
      clearBan: (userId) => {
        cleared.push(userId)
        return Promise.resolve()
      },
      revokeAll: (userId) => {
        revoked.push(userId)
        return Promise.resolve(1)
      },
    },
    now: () => NOW,
  })
  return { repo, svc, banned, cleared, revoked }
}

/** A timestamp `hours` before NOW. */
function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000)
}

describe("admin users pure helpers", () => {
  it("resolveUserFilter maps the design facet to status + flaggedOnly", () => {
    expect(resolveUserFilter("all")).toEqual({ status: null, flaggedOnly: false })
    expect(resolveUserFilter("active")).toEqual({ status: "active", flaggedOnly: false })
    expect(resolveUserFilter("suspended")).toEqual({ status: "suspended", flaggedOnly: false })
    expect(resolveUserFilter("flagged")).toEqual({ status: null, flaggedOnly: true })
  })
})

describe("admin users list", () => {
  it("projects a list row with status/counts and rel/abs labels", async () => {
    const { repo, svc } = harness()
    repo.seedUser({
      id: "u-1",
      name: "Jane Neighbor",
      handle: "jane",
      emailVerified: true,
      city: "Austin",
      joinedAt: new Date(Date.UTC(2025, 0, 1)),
      lastActiveAt: hoursAgo(5),
      accountStatus: "active",
      reports: 7,
      cleanups: 2,
      removals: 1,
      strikes: 0,
      risk: "watch",
    })
    const page = await svc.list({})
    const row = page.items[0]!
    expect(row.name).toBe("Jane Neighbor")
    expect(row.city).toBe("Austin")
    expect(row.status).toBe("active")
    expect(row.reports).toBe(7)
    expect(row.cleanups).toBe(2)
    expect(row.removals).toBe(1)
    expect(row.risk).toBe("watch")
    expect(row.lastActive).toBe("5h")
    expect(row.joined).toContain("2025")
  })

  it("filters by status (active/suspended) and by flagged", async () => {
    const { repo, svc } = harness()
    repo.seedUser({ id: "a", accountStatus: "active" })
    repo.seedUser({ id: "s", accountStatus: "suspended" })
    repo.seedUser({ id: "b", accountStatus: "banned" })
    repo.seedUser({ id: "f", accountStatus: "active", flagged: true, flagReason: "spammy" })

    expect((await svc.list({ filter: "active" })).items.map((i) => i.id).sort()).toEqual(["a", "f"])
    expect((await svc.list({ filter: "suspended" })).items.map((i) => i.id)).toEqual(["s"])
    const flagged = (await svc.list({ filter: "flagged" })).items
    expect(flagged.map((i) => i.id)).toEqual(["f"])
    expect(flagged[0]?.flagReason).toBe("spammy")
  })

  it("search matches name, handle, and city (case-insensitive)", async () => {
    const { repo, svc } = harness()
    repo.seedUser({ id: "u-1", name: "Maria Lopez", handle: "mlopez", city: "Dallas" })
    repo.seedUser({ id: "u-2", name: "Sam Park", handle: "spark", city: "Austin" })
    expect((await svc.list({ q: "maria" })).items.map((i) => i.id)).toEqual(["u-1"])
    expect((await svc.list({ q: "SPARK" })).items.map((i) => i.id)).toEqual(["u-2"])
    expect((await svc.list({ q: "austin" })).items.map((i) => i.id)).toEqual(["u-2"])
  })

  it("returns accurate per-facet counts (suspended is the explicit status; flagged orthogonal)", async () => {
    const { repo, svc } = harness()
    repo.seedUser({ id: "a1", accountStatus: "active" })
    repo.seedUser({ id: "a2", accountStatus: "active", flagged: true })
    repo.seedUser({ id: "s1", accountStatus: "suspended" })
    repo.seedUser({ id: "b1", accountStatus: "banned" }) // in `all`, not in active/suspended
    // counts span ALL accounts (not the active facet) so the chips stay accurate.
    const { counts } = await svc.list({ filter: "suspended" })
    expect(counts).toEqual({ all: 4, active: 2, suspended: 1, flagged: 1 })
  })

  it("paginates with a cursor (no overlap)", async () => {
    const { repo, svc } = harness()
    for (let i = 0; i < 5; i++) {
      repo.seedUser({ id: `u${i}`, joinedAt: hoursAgo(i + 1) })
    }
    const first = await svc.list({ limit: 2 })
    expect(first.items).toHaveLength(2)
    const second = await svc.list({ limit: 2, cursor: first.nextCursor ?? undefined })
    const firstIds = new Set(first.items.map((i) => i.id))
    expect(second.items.every((i) => !firstIds.has(i.id))).toBe(true)
  })
})

describe("admin users detail + sub-lists", () => {
  it("detail includes the role and the messages-tab count", async () => {
    const { repo, svc } = harness()
    repo.seedUser({ id: "u-1", role: "gov_admin" })
    repo.seedMessage("u-1", { id: "m1", text: "hi", thread: "Cleanup", createdAt: hoursAgo(1) })
    repo.seedMessage("u-1", { id: "m2", text: "yo", thread: "Cleanup", createdAt: hoursAgo(2) })
    const detail = await svc.get("u-1")
    expect(detail.role).toBe("gov_admin")
    expect(detail.messages).toBe(2)
  })

  it("detail throws notFound for an unknown user", async () => {
    const { svc } = harness()
    await expect(svc.get("nope")).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("projects the avatar gradient + canonical avatar_url so admin matches web/mobile", async () => {
    const { repo, svc } = harness()
    repo.seedUser({ id: "u-1", avatarUrl: "https://cdn.example.test/u1.jpg" })
    repo.seedUser({ id: "u-2" }) // no photo => avatarUrl omitted, monogram via `avatar`
    const withPhoto = await svc.get("u-1")
    expect(withPhoto.avatar).toEqual(avatarGradient("u-1"))
    expect(withPhoto.avatarUrl).toBe("https://cdn.example.test/u1.jpg")
    const noPhoto = await svc.get("u-2")
    expect(noPhoto.avatar).toEqual(avatarGradient("u-2"))
    expect(noPhoto.avatarUrl).toBeUndefined()
  })

  it("getReports/getEvents/getMessages project the sub-activity rows", async () => {
    const { repo, svc } = harness()
    repo.seedUser({ id: "u-1" })
    repo.seedReport("u-1", {
      id: "r-1",
      category: "trash",
      title: "Bin",
      place: "Austin",
      status: "submitted",
      createdAt: hoursAgo(3),
    })
    repo.seedEvent("u-1", {
      id: "e-1",
      title: "Park day",
      place: "Austin",
      role: "organizer",
      attendees: 10,
      whenAt: hoursAgo(48),
    })
    repo.seedMessage("u-1", {
      id: "m-1",
      text: "See you there",
      thread: "Park day",
      createdAt: hoursAgo(2),
    })

    const reports = await svc.getReports({ id: "u-1" })
    expect(reports.items[0]).toMatchObject({
      id: "r-1",
      category: "trash",
      status: "submitted",
      age: "3h",
    })
    const events = await svc.getEvents({ id: "u-1" })
    expect(events.items[0]).toMatchObject({ id: "e-1", role: "organizer", attendees: 10 })
    const messages = await svc.getMessages({ id: "u-1" })
    expect(messages.items[0]).toMatchObject({
      id: "m-1",
      text: "See you there",
      thread: "Park day",
    })
  })

  it("sub-lists throw notFound for an unknown user", async () => {
    const { svc } = harness()
    await expect(svc.getReports({ id: "nope" })).rejects.toMatchObject({ httpStatus: 404 })
    await expect(svc.getEvents({ id: "nope" })).rejects.toMatchObject({ httpStatus: 404 })
    await expect(svc.getMessages({ id: "nope" })).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("sub-lists paginate with a cursor", async () => {
    const { repo, svc } = harness()
    repo.seedUser({ id: "u-1" })
    for (let i = 0; i < 5; i++) {
      repo.seedReport("u-1", {
        id: `r${i}`,
        category: "other",
        title: `R${i}`,
        place: "X",
        status: "submitted",
        createdAt: hoursAgo(i + 1),
      })
    }
    const first = await svc.getReports({ id: "u-1", limit: 2 })
    expect(first.items).toHaveLength(2)
    const second = await svc.getReports({
      id: "u-1",
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    })
    const firstIds = new Set(first.items.map((i) => i.id))
    expect(second.items.every((i) => !firstIds.has(i.id))).toBe(true)
  })
})

describe("admin users mutations", () => {
  it("flag toggles user_moderation.flagged on then off, each audited", async () => {
    const { repo, svc } = harness()
    repo.seedUser({ id: "u-1", flagged: false })
    const on = await svc.flag("u-1", { reason: "abuse", actorId: "op-1" })
    expect(on).toBe(true)
    expect(repo.users.get("u-1")?.flagged).toBe(true)
    expect(repo.users.get("u-1")?.flagReason).toBe("abuse")
    expect(repo.audits.at(-1)).toMatchObject({ action: "user.flagged", target: "user:u-1" })

    const off = await svc.flag("u-1", { reason: null, actorId: "op-1" })
    expect(off).toBe(false)
    expect(repo.users.get("u-1")?.flagged).toBe(false)
    expect(repo.audits.at(-1)).toMatchObject({ action: "user.unflagged" })
  })

  it("flag throws notFound for an unknown user", async () => {
    const { svc } = harness()
    await expect(svc.flag("nope", { reason: null, actorId: null })).rejects.toMatchObject({
      httpStatus: 404,
    })
  })

  it("setStatus to suspended sets account_status, audits, clears the ban marker, and does NOT revoke sessions", async () => {
    const { repo, svc, banned, cleared } = harness()
    repo.seedUser({ id: "u-1", accountStatus: "active" })
    const result = await svc.setStatus("u-1", {
      status: "suspended",
      reason: "warnings",
      actorId: "op-1",
    })
    expect(result.revokedSessions).toBe(0)
    expect(repo.users.get("u-1")?.accountStatus).toBe("suspended")
    expect(banned).toHaveLength(0)
    // H2: a non-ban status lifts any stale ban marker (idempotent) but does not revoke sessions.
    expect(cleared).toEqual(["u-1"])
    expect(repo.audits.at(-1)).toMatchObject({
      action: "user.status_changed",
      meta: { status: "suspended" },
    })
  })

  it("setStatus to banned sets account_status, BANS (revoke + marker), and audits user.banned (H2)", async () => {
    const { repo, svc, banned, cleared } = harness()
    repo.seedUser({ id: "u-1", accountStatus: "active" })
    const result = await svc.setStatus("u-1", { status: "banned", reason: "tos", actorId: "op-1" })
    expect(repo.users.get("u-1")?.accountStatus).toBe("banned")
    // H2: ban revokes all sessions AND sets the banned marker (via sessions.ban); does not clearBan.
    expect(banned).toEqual(["u-1"])
    expect(cleared).toHaveLength(0)
    expect(result.revokedSessions).toBeGreaterThanOrEqual(1)
    expect(repo.audits.at(-1)).toMatchObject({ action: "user.banned", target: "user:u-1" })
  })

  it("setStatus surfaces a ban-revoke failure (H2: a failed ban must NOT 200)", async () => {
    const repo = new InMemoryAdminUserRepository()
    repo.seedUser({ id: "u-1", accountStatus: "active" })
    const svc = makeAdminUserService({
      repo,
      sessions: {
        ban: () => Promise.reject(new Error("redis down")),
        clearBan: () => Promise.resolve(),
        revokeAll: () => Promise.resolve(0),
      },
      now: () => NOW,
    })
    await expect(
      svc.setStatus("u-1", { status: "banned", reason: "tos", actorId: "op-1" }),
    ).rejects.toThrow("redis down")
  })

  it("setStatus throws notFound for an unknown user", async () => {
    const { svc } = harness()
    await expect(
      svc.setStatus("nope", { status: "banned", reason: null, actorId: null }),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("setRole writes the role + audit atomically AND revokes sessions so the change takes effect (H2/L5)", async () => {
    const { repo, svc, revoked } = harness()
    repo.seedUser({ id: "u-1", role: "gov_admin" })
    await svc.setRole("u-1", { role: "citizen", actorId: "op-1" })
    // L5: the repo applied the role itself, in the same step as the audit (no separate setUserRole seam).
    expect(repo.users.get("u-1")?.role).toBe("citizen")
    // H2: the demotion revokes all the user's sessions so the cached role cannot outlive it.
    expect(revoked).toEqual(["u-1"])
    expect(repo.audits.at(-1)).toMatchObject({
      action: "user.role_changed",
      meta: { role: "citizen", priorRole: "gov_admin" },
    })
  })

  it("setRole throws notFound for an unknown user (before writing the role or revoking)", async () => {
    const { svc, revoked } = harness()
    await expect(svc.setRole("nope", { role: "citizen", actorId: null })).rejects.toMatchObject({
      httpStatus: 404,
    })
    expect(revoked).toHaveLength(0)
  })

  // --- H3: the three privilege-escalation guards on POST /admin/users/:id/role ---

  it("H3: REFUSES to grant `operator` (no console-minted operator backdoor)", async () => {
    const { repo, svc, revoked } = harness()
    repo.seedUser({ id: "u-1", role: "citizen" })
    await expect(svc.setRole("u-1", { role: "operator", actorId: "op-1" })).rejects.toMatchObject({
      httpStatus: 403,
    })
    // Nothing was written and no session was touched.
    expect(repo.users.get("u-1")?.role).toBe("citizen")
    expect(repo.audits).toHaveLength(0)
    expect(revoked).toHaveLength(0)
  })

  it("H3: REFUSES a self-targeted role change", async () => {
    const { repo, svc, revoked } = harness()
    repo.seedUser({ id: "op-1", role: "operator" })
    await expect(svc.setRole("op-1", { role: "citizen", actorId: "op-1" })).rejects.toMatchObject({
      httpStatus: 403,
    })
    expect(repo.users.get("op-1")?.role).toBe("operator")
    expect(revoked).toHaveLength(0)
  })

  it("H3: REFUSES to demote an existing operator (one operator cannot strip the others)", async () => {
    const { repo, svc, revoked } = harness()
    repo.seedUser({ id: "u-1", role: "operator" })
    await expect(svc.setRole("u-1", { role: "citizen", actorId: "op-2" })).rejects.toMatchObject({
      httpStatus: 403,
    })
    expect(repo.users.get("u-1")?.role).toBe("operator")
    expect(repo.audits).toHaveLength(0)
    expect(revoked).toHaveLength(0)
  })

  it("H3: REFUSES to ban an existing operator", async () => {
    const { repo, svc, banned } = harness()
    repo.seedUser({ id: "u-1", role: "operator", accountStatus: "active" })
    await expect(
      svc.setStatus("u-1", { status: "banned", reason: "hostile takeover", actorId: "op-2" }),
    ).rejects.toMatchObject({ httpStatus: 403 })
    expect(repo.users.get("u-1")?.accountStatus).toBe("active")
    expect(banned).toHaveLength(0)
  })

  it("H3: still allows a normal non-operator role change (the guards are not a blanket refusal)", async () => {
    const { repo, svc, revoked } = harness()
    repo.seedUser({ id: "u-1", role: "citizen" })
    await svc.setRole("u-1", { role: "gov_admin", actorId: "op-1" })
    expect(repo.users.get("u-1")?.role).toBe("gov_admin")
    expect(revoked).toEqual(["u-1"])
  })
})
