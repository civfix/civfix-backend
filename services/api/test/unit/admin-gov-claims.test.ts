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

const NOW = new Date("2026-06-06T00:00:00.000Z")

function harness(): {
  repo: InMemoryGovClaimsRepository
  users: InMemoryUserProvisioner
  svc: GovClaimsService
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

  function seedOnePerStatus(repo: InMemoryGovClaimsRepository): void {
    repo.seedClaim({ id: "PEND", status: "pending", contactEmail: "a@gov.test" })
    repo.seedClaim({ id: "APPR", status: "approved", contactEmail: "b@gov.test" })
    repo.seedClaim({ id: "REJ", status: "rejected", contactEmail: "c@gov.test" })
  }

  it("an OMITTED filter lists only PENDING claims (the queue's back-compatible default)", async () => {
    const { repo, svc } = harness()
    seedOnePerStatus(repo)

    const page = await svc.list({})
    expect(page.items.map((i) => i.id)).toEqual(["PEND"])
  })

  it('filter="all" lists claims of EVERY status', async () => {
    const { repo, svc } = harness()
    seedOnePerStatus(repo)

    const page = await svc.list({ filter: "all" })
    expect(page.items.map((i) => i.id)).toEqual(["REJ", "APPR", "PEND"])
    expect(page.items.map((i) => i.status).sort()).toEqual(["approved", "pending", "rejected"])
  })

  it('filter="pending" lists only pending claims', async () => {
    const { repo, svc } = harness()
    seedOnePerStatus(repo)

    const page = await svc.list({ filter: "pending" })
    expect(page.items.map((i) => i.id)).toEqual(["PEND"])
  })

  it('filter="approved" lists only APPROVED claims', async () => {
    const { repo, svc } = harness()
    seedOnePerStatus(repo)

    const page = await svc.list({ filter: "approved" })
    expect(page.items.map((i) => i.id)).toEqual(["APPR"])
    expect(page.items[0]?.status).toBe("approved")
  })

  it('filter="rejected" lists only REJECTED claims', async () => {
    const { repo, svc } = harness()
    seedOnePerStatus(repo)

    const page = await svc.list({ filter: "rejected" })
    expect(page.items.map((i) => i.id)).toEqual(["REJ"])
    expect(page.items[0]?.status).toBe("rejected")
  })

  it("search matches name or org (case-insensitive) and composes with the status facet", async () => {
    const { repo, svc } = harness()
    repo.seedClaim({ id: "A", name: "Dana Lee", org: "City of LA", contactEmail: "a@gov.test" })
    repo.seedClaim({ id: "B", name: "Sam Roe", org: "Town of Vienna", contactEmail: "b@gov.test" })
    repo.seedClaim({
      id: "C",
      name: "Dana Fox",
      org: "City of Reno",
      contactEmail: "c@gov.test",
      status: "rejected",
    })

    expect((await svc.list({ q: "dana" })).items.map((i) => i.id)).toEqual(["A"])
    expect((await svc.list({ q: "dana", filter: "all" })).items.map((i) => i.id)).toEqual([
      "C",
      "A",
    ])
    expect((await svc.list({ q: "dana", filter: "rejected" })).items.map((i) => i.id)).toEqual([
      "C",
    ])
    expect((await svc.list({ q: "vienna" })).items.map((i) => i.id)).toEqual(["B"])
    expect((await svc.list({ q: "nomatch" })).items).toHaveLength(0)
  })

  it('sort="oldest" reverses the queue order', async () => {
    const { repo, svc } = harness()
    repo.seedClaim({ id: "first", contactEmail: "a@gov.test" })
    repo.seedClaim({ id: "second", contactEmail: "b@gov.test" })
    repo.seedClaim({ id: "third", contactEmail: "c@gov.test" })

    expect((await svc.list({})).items.map((i) => i.id)).toEqual(["third", "second", "first"])
    expect((await svc.list({ sort: "oldest" })).items.map((i) => i.id)).toEqual([
      "first",
      "second",
      "third",
    ])
    expect((await svc.list({ sort: "sideways" })).items.map((i) => i.id)).toEqual([
      "third",
      "second",
      "first",
    ])
  })

  it('pages with a cursor under sort="oldest" without skipping or repeating a row', async () => {
    const { repo, svc } = harness()
    repo.seedClaim({ id: "first", contactEmail: "a@gov.test" })
    repo.seedClaim({ id: "second", contactEmail: "b@gov.test" })
    repo.seedClaim({ id: "third", contactEmail: "c@gov.test" })

    const page1 = await svc.list({ sort: "oldest", limit: 2 })
    expect(page1.items.map((i) => i.id)).toEqual(["first", "second"])
    expect(page1.nextCursor).not.toBeNull()

    const page2 = await svc.list({ sort: "oldest", limit: 2, cursor: page1.nextCursor! })
    expect(page2.items.map((i) => i.id)).toEqual(["third"])
    expect(page2.nextCursor).toBeNull()
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
    expect(detail.checks.directory).toEqual({
      status: "verified",
      evidence: "https://directory",
      note: "found",
    })
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
        actorId: "op-1",
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
    expect(claim.userId).not.toBeNull()
    expect(claim.jurisdictionGeoid).toBe("5182672")
    const created = await users.findByEmail("dana@waynesboro-va.gov")
    expect(created).not.toBeNull()
    expect(created?.role).toBe("gov_admin")
    expect(claim.userId).toBe(created?.id)
  })

  it("F118: a raced/non-pending approve conflicts and leaves the placeholder a plain citizen (no unjustified gov_admin)", async () => {
    const { repo, users, svc } = harness()
    repo.seedClaim({
      id: "GOV-1",
      contactEmail: "dana@waynesboro-va.gov",
      status: "approved",
    })

    await expect(svc.approve("GOV-1", { actorId: "op-1", note: null })).rejects.toMatchObject({
      httpStatus: 409,
    })

    const placeholder = await users.findByEmail("dana@waynesboro-va.gov")
    expect(placeholder?.role ?? "citizen").toBe("citizen")
  })

  it("reuses an existing user by email and grants gov_admin (idempotent)", async () => {
    const { repo, users, svc } = harness()
    const existing = users.seedUser({ email: "dana@waynesboro-va.gov", role: "citizen" })
    repo.seedClaim({ id: "GOV-1", contactEmail: "dana@waynesboro-va.gov", status: "pending" })

    await svc.approve("GOV-1", { actorId: "op-1", note: null })

    expect(users.users.size).toBe(1)
    expect(users.users.get(existing.id)?.role).toBe("gov_admin")
    expect(repo.claims.get("GOV-1")?.userId).toBe(existing.id)
  })

  it("M4: revokes ALL the elevated user's sessions after the role change", async () => {
    const { repo, users, svc, revoked } = harness()
    const existing = users.seedUser({ email: "dana@waynesboro-va.gov", role: "citizen" })
    repo.seedClaim({ id: "GOV-1", contactEmail: "dana@waynesboro-va.gov", status: "pending" })

    await svc.approve("GOV-1", { actorId: "op-1", note: null })

    expect(users.users.get(existing.id)?.role).toBe("gov_admin")
    expect(revoked).toEqual([existing.id])
  })

  it("M4: a revoke failure SURFACES (a half-applied privilege change must not 200)", async () => {
    const { repo, users } = harness()
    const existing = users.seedUser({ email: "dana@waynesboro-va.gov", role: "citizen" })
    repo.seedClaim({ id: "GOV-1", contactEmail: "dana@waynesboro-va.gov", status: "pending" })
    const svc = makeGovClaimsService({
      repo,
      users,
      revokeSessions: () => Promise.reject(new Error("redis down")),
      now: () => NOW,
    })
    await expect(svc.approve("GOV-1", { actorId: "op-1", note: null })).rejects.toThrow(
      "redis down",
    )
    expect(users.users.get(existing.id)?.role).toBe("gov_admin")
    expect(repo.claims.get("GOV-1")?.status).toBe("approved")
  })

  it("H3: refuses to re-role an OPERATOR account through the gov queue (403, nothing written)", async () => {
    const { repo, users, svc, revoked } = harness()
    const operator = users.seedUser({ email: "op@city.gov", role: "operator" })
    repo.seedClaim({ id: "GOV-1", contactEmail: "op@city.gov", status: "pending" })

    await expect(svc.approve("GOV-1", { actorId: "op-1", note: null })).rejects.toMatchObject({
      httpStatus: 403,
    })
    expect(users.users.get(operator.id)?.role).toBe("operator")
    expect(repo.claims.get("GOV-1")?.status).toBe("pending")
    expect(repo.claims.get("GOV-1")?.userId).toBeNull()
    expect(revoked).toEqual([])
  })

  it("refuses to elevate a pre-existing account whose email is NOT verified (422)", async () => {
    const { repo, users, svc, revoked } = harness()
    const victim = users.seedUser({
      email: "victim@example.com",
      role: "citizen",
      emailVerified: false,
    })
    repo.seedClaim({ id: "GOV-1", contactEmail: "victim@example.com", status: "pending" })

    await expect(svc.approve("GOV-1", { actorId: "op-1", note: null })).rejects.toMatchObject({
      httpStatus: 422,
    })
    expect(users.users.get(victim.id)?.role).toBe("citizen")
    expect(repo.claims.get("GOV-1")?.status).toBe("pending")
    expect(revoked).toEqual([])
  })

  it("rejects approving a claim with no contact email", async () => {
    const { repo, svc } = harness()
    repo.seedClaim({ id: "GOV-1", contactEmail: null, status: "pending" })
    await expect(svc.approve("GOV-1", { actorId: "op-1", note: null })).rejects.toMatchObject({
      httpStatus: 422,
    })
  })

  it("M2: a concurrent decision (approve returns null) does NOT leave the user elevated", async () => {
    const repo = new InMemoryGovClaimsRepository()
    repo.now = NOW
    repo.seedClaim({ id: "GOV-1", contactEmail: "dana@waynesboro-va.gov", status: "pending" })
    const users = new InMemoryUserProvisioner()
    const racingRepo = {
      ...repo,
      getClaim: (id: string) => repo.getClaim(id),
      approve: () => Promise.resolve(null),
      reject: (id: string, input: { reason: string; actorId: string | null }) =>
        repo.reject(id, input),
      list: repo.list.bind(repo),
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
    const u = await users.findByEmail("dana@waynesboro-va.gov")
    expect(u?.role).not.toBe("gov_admin")
  })

  it("rejects approving a non-pending claim (conflict)", async () => {
    const { repo, svc } = harness()
    repo.seedClaim({ id: "GOV-1", contactEmail: "x@gov.test", status: "approved" })
    await expect(svc.approve("GOV-1", { actorId: "op-1", note: null })).rejects.toMatchObject({
      httpStatus: 409,
    })
  })

  it("throws notFound for an unknown claim", async () => {
    const { svc } = harness()
    await expect(svc.approve("nope", { actorId: "op-1", note: null })).rejects.toMatchObject({
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
    await expect(svc.reject("GOV-1", { reason: "late", actorId: "op-1" })).rejects.toMatchObject({
      httpStatus: 409,
    })
  })

  it("rejecting an unknown claim is a notFound", async () => {
    const { svc } = harness()
    await expect(svc.reject("nope", { reason: "x", actorId: "op-1" })).rejects.toMatchObject({
      httpStatus: 404,
    })
  })
})
