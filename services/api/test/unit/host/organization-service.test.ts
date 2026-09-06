import { beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { InMemoryOrganizationRepository } from "../../../src/services/host/organization-repository.memory.js"
import {
  makeOrganizationService,
  ORGS_CREATED_PER_DAY,
  type OrganizationService,
} from "../../../src/services/host/organization-service.js"

const OWNER = "11111111-1111-4111-8111-111111111111"
const ADMIN = "22222222-2222-4222-8222-222222222222"
const MEMBER = "33333333-3333-4333-8333-333333333333"
const STRANGER = "44444444-4444-4444-8444-444444444444"
const OPERATOR = "55555555-5555-4555-8555-555555555555"

let repo: InMemoryOrganizationRepository
let service: OrganizationService
let clock: Date

function base(over: Record<string, unknown> = {}) {
  return {
    name: "Ballona Creek Trust",
    slug: "ballona-creek-trust",
    ...over,
  } as Parameters<OrganizationService["createOrganization"]>[0]
}

beforeEach(() => {
  repo = new InMemoryOrganizationRepository()
  repo.seedUser({ id: OWNER, displayName: "Olive Owner", handle: "olive", email: "olive@x.org" })
  repo.seedUser({ id: ADMIN, displayName: "Adam Admin", handle: "adam", email: "adam@x.org" })
  repo.seedUser({ id: MEMBER, displayName: "Mel Member", handle: "mel", email: "mel@x.org" })
  repo.seedUser({ id: STRANGER, displayName: "Sam Stranger", handle: "sam" })
  clock = new Date("2026-09-06T12:00:00.000Z")
  service = makeOrganizationService({
    repo,
    counters: new InMemoryCounterStore(() => clock.getTime()),
    now: () => clock,
    newId: () => randomUUID(),
    presignLogo: (key) => Promise.resolve(`https://cdn.test/${key}`),
  })
})

describe("createOrganization", () => {
  it("makes the creator the sole owner and starts unverified", async () => {
    const dto = await service.createOrganization(base(), OWNER)
    expect(dto.slug).toBe("ballona-creek-trust")
    expect(dto.myRole).toBe("owner")
    expect(dto.verifiedStatus).toBe("unverified")
    expect(dto.memberCount).toBe(1)
    expect(repo.members.filter((m) => m.role === "owner")).toHaveLength(1)
  })

  it("409s a slug that is already live", async () => {
    await service.createOrganization(base(), OWNER)
    await expect(service.createOrganization(base(), ADMIN)).rejects.toMatchObject({
      code: "CONFLICT",
    })
  })

  it("422s a reserved slug before it ever reaches the database", async () => {
    await expect(service.createOrganization(base({ slug: "admin" }), OWNER)).rejects.toMatchObject({
      code: "VALIDATION",
    })
    expect(repo.organizations.size).toBe(0)
  })

  it("422s a slur in the name", async () => {
    await expect(
      service.createOrganization(base({ name: "Trust of nigger" }), OWNER),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it(`caps a host at ${ORGS_CREATED_PER_DAY} organizations a day`, async () => {
    for (let i = 0; i < ORGS_CREATED_PER_DAY; i += 1) {
      await service.createOrganization(base({ slug: `org-${i}`, name: `Org ${i}` }), OWNER)
    }
    await expect(
      service.createOrganization(base({ slug: "org-extra", name: "Org extra" }), OWNER),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
  })

  it("presigns the logo when one is attached", async () => {
    const logoMediaId = randomUUID()
    const dto = await service.createOrganization(base({ logoMediaId }), OWNER)
    expect(dto.logoUrl).toBe(`https://cdn.test/media/${logoMediaId}`)
  })
})

describe("membership", () => {
  async function seeded(): Promise<string> {
    const dto = await service.createOrganization(base(), OWNER)
    await service.inviteMember(dto.id, OWNER, {
      identifierKind: "handle",
      identifier: "adam",
      role: "admin",
    })
    await service.inviteMember(dto.id, OWNER, {
      identifierKind: "email",
      identifier: "mel@x.org",
      role: "member",
    })
    return dto.id
  }

  it("adds by handle and by verified email, and reports whether it landed", async () => {
    const id = await seeded()
    const page = await service.listMembers(id, OWNER, { cursor: null, limit: 25 })
    expect(page.items.map((m) => m.role)).toEqual(["owner", "admin", "member"])
  })

  it("answers identically whether or not the address belongs to an account", async () => {
    const dto = await service.createOrganization(base(), OWNER)
    const miss = await service.inviteMember(dto.id, OWNER, {
      identifierKind: "email",
      identifier: "nobody@example.com",
      role: "member",
    })
    const hit = await service.inviteMember(dto.id, OWNER, {
      identifierKind: "email",
      identifier: "mel@x.org",
      role: "member",
    })
    expect(miss).toEqual({ ok: true, member: null, invited: true })
    expect(hit).toEqual(miss)
    expect(JSON.stringify(hit)).not.toContain("Mel Member")
  })

  it("lets a member leave an organization they were added to", async () => {
    const dto = await service.createOrganization(base(), OWNER)
    await service.inviteMember(dto.id, OWNER, {
      identifierKind: "handle",
      identifier: "mel",
      role: "member",
    })
    await expect(service.removeMember(dto.id, MEMBER, MEMBER)).resolves.toEqual({ ok: true })
    await expect(
      service.listMembers(dto.id, MEMBER, { cursor: null, limit: 25 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("refuses to let the owner leave without transferring ownership", async () => {
    const dto = await service.createOrganization(base(), OWNER)
    await expect(service.removeMember(dto.id, OWNER, OWNER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  it("404s a non-member before it ever says 'forbidden'", async () => {
    const id = await seeded()
    await expect(
      service.listMembers(id, STRANGER, { cursor: null, limit: 25 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("403s a plain member trying to manage the team", async () => {
    const id = await seeded()
    await expect(
      service.setMemberRole(id, MEMBER, ADMIN, "member"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("refuses to change or remove the owner", async () => {
    const id = await seeded()
    await expect(service.setMemberRole(id, ADMIN, OWNER, "member")).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(service.removeMember(id, ADMIN, OWNER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  it("audits every role change", async () => {
    const id = await seeded()
    await service.setMemberRole(id, OWNER, MEMBER, "admin")
    expect(
      repo.audits.filter((a) => a.action === "org.member_role_changed").length,
    ).toBeGreaterThanOrEqual(3)
  })

  it("refuses to let anyone change their own role", async () => {
    const id = await seeded()
    await expect(service.setMemberRole(id, OWNER, OWNER, "member")).rejects.toMatchObject({
      code: "CONFLICT",
    })
  })

  it("org membership is owner-managed: an admin holds no manage_team", async () => {
    const id = await seeded()
    await expect(
      service.inviteMember(id, ADMIN, {
        identifierKind: "handle",
        identifier: "sam",
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})

describe("verification", () => {
  async function seeded(): Promise<string> {
    const dto = await service.createOrganization(base(), OWNER)
    await service.inviteMember(dto.id, OWNER, {
      identifierKind: "handle",
      identifier: "adam",
      role: "admin",
    })
    return dto.id
  }

  it("only the owner may apply (manage_org_link is organizer-only)", async () => {
    const id = await seeded()
    await expect(
      service.applyVerification(id, ADMIN, { kind: "nonprofit", documents: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("moves the organization to pending and records who submitted", async () => {
    const id = await seeded()
    const dto = await service.applyVerification(id, OWNER, {
      kind: "nonprofit",
      einNumber: "12-3456789",
      documents: [{ mediaId: randomUUID() }],
      note: "501(c)(3) determination letter attached",
    })
    expect(dto.status).toBe("pending")
    expect(repo.organizations.get(id)?.verifiedStatus).toBe("pending")
  })

  it("keeps the open application's documents when a re-submission omits them", async () => {
    const id = await seeded()
    const doc = randomUUID()
    await service.applyVerification(id, OWNER, { kind: "nonprofit", documents: [{ mediaId: doc }] })
    await service.applyVerification(id, OWNER, { kind: "nonprofit", documents: [], note: "fixed" })
    const page = await service.adminListVerifications({ cursor: null, limit: 25 })
    expect(page.items[0]?.documentMediaIds).toEqual([doc])
    expect(page.items[0]?.note).toBe("fixed")
  })

  it("replaces the document list when a re-submission names one, de-duplicated", async () => {
    const id = await seeded()
    const first = randomUUID()
    const second = randomUUID()
    await service.applyVerification(id, OWNER, {
      kind: "nonprofit",
      documents: [{ mediaId: first }],
    })
    await service.applyVerification(id, OWNER, {
      kind: "nonprofit",
      documents: [{ mediaId: first }, { mediaId: second }, { mediaId: second }],
    })
    const page = await service.adminListVerifications({ cursor: null, limit: 25 })
    expect(page.items[0]?.documentMediaIds).toEqual([first, second])
  })

  it("never returns the EIN or the documents to the organization", async () => {
    const id = await seeded()
    const dto = await service.applyVerification(id, OWNER, {
      kind: "nonprofit",
      einNumber: "12-3456789",
      documents: [{ mediaId: randomUUID() }],
    })
    expect(JSON.stringify(dto)).not.toContain("3456789")
    const read = await service.getVerification(id, OWNER)
    expect(JSON.stringify(read)).not.toContain("3456789")
  })

  it("gives the operator queue only the last four EIN digits", async () => {
    const id = await seeded()
    await service.applyVerification(id, OWNER, {
      kind: "nonprofit",
      einNumber: "12-3456789",
      documents: [],
    })
    const page = await service.adminListVerifications({ cursor: null, limit: 25 })
    expect(page.items[0]?.einLast4).toBe("6789")
    expect(page.pendingCount).toBe(1)
  })

  it("a rejection needs a reason and clears any donation link", async () => {
    const id = await seeded()
    await service.applyVerification(id, OWNER, { kind: "nonprofit", documents: [] })
    await expect(
      service.adminDecideVerification(id, OPERATOR, { decision: "rejected" }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    const dto = await service.adminDecideVerification(id, OPERATOR, {
      decision: "rejected",
      reason: "no determination letter",
    })
    expect(dto.verifiedStatus).toBe("rejected")
    expect(dto.verifiedKind).toBeNull()
  })

  it("approval stamps the granted kind and is audited", async () => {
    const id = await seeded()
    await service.applyVerification(id, OWNER, { kind: "nonprofit", documents: [] })
    const dto = await service.adminDecideVerification(id, OPERATOR, { decision: "verified" })
    expect(dto.verifiedStatus).toBe("verified")
    expect(dto.verifiedKind).toBe("nonprofit")
    expect(repo.audits.some((a) => a.action === "org.verification_verified")).toBe(true)
  })

  it("copies a verified nonprofit's EIN in the approval itself and hands it to the eligibility hook, and only then", async () => {
    const events: { organizationId: string; ein: string | null; operatorId: string }[] = []
    const copied: { organizationId: string; ein: string; source: string; actorUserId: string | null }[] = []
    repo.eligibilityEinSink = (input) => {
      copied.push(input)
    }
    const hooked = makeOrganizationService({
      repo,
      counters: new InMemoryCounterStore(() => clock.getTime()),
      now: () => clock,
      newId: () => randomUUID(),
      onNonprofitVerified: (event) => {
        events.push(event)
        return Promise.resolve()
      },
    })
    const nonprofit = await seeded()
    await hooked.applyVerification(nonprofit, OWNER, {
      kind: "nonprofit",
      einNumber: "95-4327245",
      documents: [],
    })
    await hooked.adminDecideVerification(nonprofit, OPERATOR, { decision: "verified" })
    expect(events).toEqual([{ organizationId: nonprofit, ein: "95-4327245", operatorId: OPERATOR }])
    expect(copied).toEqual([
      { organizationId: nonprofit, ein: "954327245", source: "org_verification", actorUserId: OPERATOR, now: clock },
    ])

    const community = await hooked.createOrganization(base({ slug: "community-org", name: "Community Org" }), OWNER)
    await hooked.applyVerification(community.id, OWNER, { kind: "community", documents: [] })
    await hooked.adminDecideVerification(community.id, OPERATOR, { decision: "verified" })
    const rejected = await hooked.createOrganization(base({ slug: "rejected-org", name: "Rejected Org" }), OWNER)
    await hooked.applyVerification(rejected.id, OWNER, { kind: "nonprofit", documents: [] })
    await hooked.adminDecideVerification(rejected.id, OPERATOR, { decision: "rejected", reason: "no letter" })
    expect(events).toHaveLength(1)
    expect(copied).toHaveLength(1)
  })

  it("never fails an approval because the eligibility follow-up failed", async () => {
    const errors: unknown[] = []
    const failing = makeOrganizationService({
      repo,
      counters: new InMemoryCounterStore(() => clock.getTime()),
      now: () => clock,
      newId: () => randomUUID(),
      onNonprofitVerified: () => Promise.reject(new Error("queue down")),
      logger: { error: (obj) => errors.push(obj) },
    })
    const id = await seeded()
    await failing.applyVerification(id, OWNER, { kind: "nonprofit", einNumber: "95-4327245", documents: [] })
    const dto = await failing.adminDecideVerification(id, OPERATOR, { decision: "verified" })
    expect(dto.verifiedStatus).toBe("verified")
    expect(errors).toHaveLength(1)
  })

  it("409s a decision when no application is open", async () => {
    const id = await seeded()
    await expect(
      service.adminDecideVerification(id, OPERATOR, { decision: "verified" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("scrubs the EIN 90 days after the decision, keeping the row", async () => {
    const id = await seeded()
    await service.applyVerification(id, OWNER, {
      kind: "nonprofit",
      einNumber: "12-3456789",
      documents: [],
    })
    await service.adminDecideVerification(id, OPERATOR, { decision: "verified" })
    expect(await service.scrubDecidedEins(100)).toBe(0)
    clock = new Date(clock.getTime() + 91 * 24 * 60 * 60 * 1000)
    expect(await service.scrubDecidedEins(100)).toBe(1)
    expect(repo.verifications[0]?.einNumber).toBeNull()
    expect(repo.verifications).toHaveLength(1)
  })
})
