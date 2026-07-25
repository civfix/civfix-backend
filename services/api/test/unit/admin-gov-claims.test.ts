import { describe, it, expect } from "vitest"
import {
  InMemoryGovClaimsRepository,
  InMemoryUserProvisioner,
} from "../../src/services/admin/gov-claims-repository.memory.js"
import {
  makeGovClaimsService,
  pendingChecks,
  toChecksDTO,
  verifiedChecks,
  type GovClaimsService,
} from "../../src/services/admin/gov-claims-service.js"

/**
 * Offline unit tests for the admin gov-provisioning service over the in-memory GovClaimsRepository +
 * UserProvisioner (no DB, no Docker). They cover the pending queue (list + search), the detail
 * projection (verified[]/pending[] derived from the checks map), verify (toggles a check in the checks
 * jsonb), approve (provisions the user as gov_admin + links the jurisdiction + status approved), and
 * reject (status + reason), plus the pure check-partition helpers.
 */

const NOW = new Date("2026-06-06T00:00:00.000Z")

function harness(): {
  repo: InMemoryGovClaimsRepository
  users: InMemoryUserProvisioner
  svc: GovClaimsService
  /** M4: userIds whose sessions the approve path revoked. */
  revoked: string[]
} {
  const repo = new InMemoryGovClaimsRepository()
  repo.now = NOW
  const users = new InMemoryUserProvisioner()
  const revoked: string[] = []
  const svc = makeGovClaimsService({
    repo,
    users,
    revokeSessions: (userId) => {
      revoked.push(userId)
      return Promise.resolve(1)
    },
    now: () => NOW,
  })
  return { repo, users, svc, revoked }
}

/** A timestamp `hours` before NOW. */
function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000)
}

describe("gov check helpers", () => {
  it("toChecksDTO fills every check (absent -> pending)", () => {
    const dto = toChecksDTO({ linkedin: { status: "verified", evidence: "url", note: null } })
    expect(dto.linkedin).toEqual({ status: "verified", evidence: "url", note: null })
    expect(dto.directory).toEqual({ status: "pending", evidence: null, note: null })
    expect(dto.callback).toEqual({ status: "pending", evidence: null, note: null })
  })

  it("verifiedChecks / pendingChecks partition the map in display order", () => {
    const checks = {
      linkedin: { status: "verified" as const, evidence: null, note: null },
      callback: { status: "verified" as const, evidence: null, note: null },
    }
    expect(verifiedChecks(checks)).toEqual(["linkedin", "callback"])
    expect(pendingChecks(checks)).toEqual(["directory"])
  })
})

describe("gov claims queue", () => {
  it("projects a pending row with name/title/org/method/age + verified/pending pills", async () => {
    const { repo, svc } = harness()
    repo.seedClaim({
      id: "GOV-1",
      name: "Dana Lee",
      title: "Public Works Director",
      org: "City of Waynesboro",
      jurisdictionGeoid: "5182672",
      method: "email",
      contactEmail: "dana@waynesboro-va.gov",
      checks: { linkedin: { status: "verified", evidence: "https://x", note: null } },
      createdAt: hoursAgo(5),
    })

    const page = await svc.list({})
    expect(page.items).toHaveLength(1)
    const row = page.items[0]!
    expect(row.id).toBe("GOV-1")
    expect(row.name).toBe("Dana Lee")
    expect(row.title).toBe("Public Works Director")
    expect(row.org).toBe("City of Waynesboro")
    expect(row.jurisdictionGeoid).toBe("5182672")
    expect(row.method).toBe("email")
    expect(row.contactEmail).toBe("dana@waynesboro-va.gov")
    expect(row.age).toBe("5h")
    expect(row.verified).toEqual(["linkedin"])
    expect(row.pending).toEqual(["directory", "callback"])
    expect(row.checks.linkedin.status).toBe("verified")
  })

  it("lists only PENDING claims", async () => {
    const { repo, svc } = harness()
    repo.seedClaim({ id: "PEND", status: "pending", contactEmail: "a@gov.test" })
    repo.seedClaim({ id: "APPR", status: "approved", contactEmail: "b@gov.test" })
    repo.seedClaim({ id: "REJ", status: "rejected", contactEmail: "c@gov.test" })

    const page = await svc.list({})
    expect(page.items.map((i) => i.id)).toEqual(["PEND"])
  })

  it("search matches name or org (case-insensitive)", async () => {
    const { repo, svc } = harness()
    repo.seedClaim({ id: "A", name: "Dana Lee", org: "City of LA", contactEmail: "a@gov.test" })
    repo.seedClaim({ id: "B", name: "Sam Roe", org: "Town of Vienna", contactEmail: "b@gov.test" })

    expect((await svc.list({ q: "dana" })).items.map((i) => i.id)).toEqual(["A"])
    expect((await svc.list({ q: "vienna" })).items.map((i) => i.id)).toEqual(["B"])
    expect((await svc.list({ q: "nomatch" })).items).toHaveLength(0)
  })
})

describe("gov claim detail", () => {
  it("returns the full checks map with verified/pending derived", async () => {
    const { repo, svc } = harness()
    repo.seedClaim({
      id: "GOV-1",
      contactEmail: "x@gov.test",
      checks: {
        linkedin: { status: "verified", evidence: "url", note: "confirmed" },
        directory: { status: "pending", evidence: null, note: null },
      },
    })
    const detail = await svc.getClaim("GOV-1")
    expect(detail.checks.linkedin).toEqual({
      status: "verified",
      evidence: "url",
      note: "confirmed",
    })
    expect(detail.checks.callback.status).toBe("pending")
    expect(detail.verified).toEqual(["linkedin"])
    expect(detail.pending).toEqual(["directory", "callback"])
  })

  it("throws notFound for an unknown claim", async () => {
    const { svc } = harness()
    await expect(svc.getClaim("nope")).rejects.toMatchObject({ httpStatus: 404 })
  })
})

describe("gov claim verify", () => {
  it("toggles a check in the checks jsonb (other checks preserved)", async () => {
    const { repo, svc } = harness()
    repo.seedClaim({
      id: "GOV-1",
      contactEmail: "x@gov.test",
      checks: { linkedin: { status: "verified", evidence: "url", note: null } },
    })

    await svc.verify("GOV-1", {
      check: "directory",
      status: "verified",
      evidence: "https://directory",
      note: "found",
      actorId: "op-1",
    })

    const detail = await svc.getClaim("GOV-1")
    // The new check is written.
    expect(detail.checks.directory).toEqual({
      status: "verified",
      evidence: "https://directory",
      note: "found",
    })
    // The pre-existing check is preserved.
    expect(detail.checks.linkedin.status).toBe("verified")
    expect(detail.verified).toEqual(["linkedin", "directory"])
  })

  it("throws notFound for an unknown claim", async () => {
    const { svc } = harness()
    await expect(
      svc.verify("nope", {
        check: "linkedin",
        status: "verified",
        evidence: null,
        note: null,
        actorId: null,
      }),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })
})

describe("gov claim approve", () => {
  it("creates the gov user with role gov_admin, links the jurisdiction, sets status approved", async () => {
    const { repo, users, svc } = harness()
    repo.seedClaim({
      id: "GOV-1",
      name: "Dana Lee",
      contactEmail: "dana@waynesboro-va.gov",
      jurisdictionGeoid: "5182672",
      status: "pending",
    })

    await svc.approve("GOV-1", { actorId: "op-1", note: "verified all three" })

    const claim = repo.claims.get("GOV-1")!
    expect(claim.status).toBe("approved")
    // The provisioned user is linked on the claim (the claim row binds the user to its jurisdiction).
    expect(claim.userId).not.toBeNull()
    expect(claim.jurisdictionGeoid).toBe("5182672")
    // A user was created with role gov_admin for the contact email.
    const created = await users.findByEmail("dana@waynesboro-va.gov")
    expect(created).not.toBeNull()
    expect(created?.role).toBe("gov_admin")
    expect(claim.userId).toBe(created?.id)
  })

  it("reuses an existing user by email and grants gov_admin (idempotent)", async () => {
    const { repo, users, svc } = harness()
    const existing = users.seedUser({ email: "dana@waynesboro-va.gov", role: "citizen" })
    repo.seedClaim({ id: "GOV-1", contactEmail: "dana@waynesboro-va.gov", status: "pending" })

    await svc.approve("GOV-1", { actorId: "op-1", note: null })

    expect(users.users.size).toBe(1) // no duplicate user
    expect(users.users.get(existing.id)?.role).toBe("gov_admin")
    expect(repo.claims.get("GOV-1")?.userId).toBe(existing.id)
  })

  /**
   * M4: a role change is only half a privilege change — the OLD role stays baked into every live session's
   * Redis projection until it expires (and sliding expiry defers that indefinitely). This path can DEMOTE a
   * current OPERATOR to gov_admin, so failing to revoke left operator authority live in every one of their
   * sessions. The grant now goes through applyRoleChange, which always revokes.
   */
  it("M4: revokes ALL the elevated user's sessions after the role change", async () => {
    const { repo, users, svc, revoked } = harness()
    const existing = users.seedUser({ email: "dana@waynesboro-va.gov", role: "operator" })
    repo.seedClaim({ id: "GOV-1", contactEmail: "dana@waynesboro-va.gov", status: "pending" })

    await svc.approve("GOV-1", { actorId: "op-1", note: null })

    expect(users.users.get(existing.id)?.role).toBe("gov_admin")
    // Without this the demoted operator keeps roles:["operator"] in every warm session.
    expect(revoked).toEqual([existing.id])
  })

  it("M4: a revoke failure SURFACES (a half-applied privilege change must not 200)", async () => {
    const { repo, users } = harness()
    users.seedUser({ email: "dana@waynesboro-va.gov", role: "operator" })
    repo.seedClaim({ id: "GOV-1", contactEmail: "dana@waynesboro-va.gov", status: "pending" })
    const svc = makeGovClaimsService({
      repo,
      users,
      revokeSessions: () => Promise.reject(new Error("redis down")),
      now: () => NOW,
    })
    await expect(svc.approve("GOV-1", { actorId: "op-1", note: null })).rejects.toThrow("redis down")
  })

  it("rejects approving a claim with no contact email", async () => {
    const { repo, svc } = harness()
    repo.seedClaim({ id: "GOV-1", contactEmail: null, status: "pending" })
    await expect(svc.approve("GOV-1", { actorId: null, note: null })).rejects.toMatchObject({
      httpStatus: 422,
    })
  })

  // M2: if the claim transition does NOT commit (a concurrent decision -> approve returns null), the user
  // must NOT have been elevated to gov_admin. The grant now happens only AFTER a successful transition.
  it("M2: a concurrent decision (approve returns null) does NOT leave the user elevated", async () => {
    const repo = new InMemoryGovClaimsRepository()
    repo.now = NOW
    repo.seedClaim({ id: "GOV-1", contactEmail: "dana@waynesboro-va.gov", status: "pending" })
    const users = new InMemoryUserProvisioner()
    // Simulate the race: getClaim still sees 'pending' (passes the precheck) but the transactional approve
    // finds the row already decided and returns null.
    const racingRepo = {
      ...repo,
      getClaim: (id: string) => repo.getClaim(id),
      approve: () => Promise.resolve(null),
      reject: (id: string, input: { reason: string; actorId: string | null }) =>
        repo.reject(id, input),
      listPending: repo.listPending.bind(repo),
      setCheck: repo.setCheck.bind(repo),
    }
    const svc = makeGovClaimsService({
      repo: racingRepo,
      users,
      revokeSessions: () => Promise.resolve(0),
      now: () => NOW,
    })

    await expect(svc.approve("GOV-1", { actorId: "op-1", note: null })).rejects.toMatchObject({
      httpStatus: 409,
    })
    // The user may have been found-or-created (harmless), but it must NOT be gov_admin: no orphan grant.
    const u = await users.findByEmail("dana@waynesboro-va.gov")
    expect(u?.role).not.toBe("gov_admin")
  })

  it("rejects approving a non-pending claim (conflict)", async () => {
    const { repo, svc } = harness()
    repo.seedClaim({ id: "GOV-1", contactEmail: "x@gov.test", status: "approved" })
    await expect(svc.approve("GOV-1", { actorId: null, note: null })).rejects.toMatchObject({
      httpStatus: 409,
    })
  })

  it("throws notFound for an unknown claim", async () => {
    const { svc } = harness()
    await expect(svc.approve("nope", { actorId: null, note: null })).rejects.toMatchObject({
      httpStatus: 404,
    })
  })
})

describe("gov claim reject", () => {
  it("sets status rejected + reason", async () => {
    const { repo, svc } = harness()
    repo.seedClaim({ id: "GOV-1", contactEmail: "x@gov.test", status: "pending" })

    await svc.reject("GOV-1", { reason: "Could not verify authority", actorId: "op-1" })

    const claim = repo.claims.get("GOV-1")!
    expect(claim.status).toBe("rejected")
    expect(claim.rejectReason).toBe("Could not verify authority")
  })

  it("rejecting a non-pending claim is a conflict", async () => {
    const { repo, svc } = harness()
    repo.seedClaim({ id: "GOV-1", contactEmail: "x@gov.test", status: "approved" })
    await expect(svc.reject("GOV-1", { reason: "late", actorId: null })).rejects.toMatchObject({
      httpStatus: 409,
    })
  })

  it("rejecting an unknown claim is a notFound", async () => {
    const { svc } = harness()
    await expect(svc.reject("nope", { reason: "x", actorId: null })).rejects.toMatchObject({
      httpStatus: 404,
    })
  })
})
