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

  it("stores the slug trimmed + lowercased even when a caller bypasses the HTTP schema", async () => {
    const dto = await service.createOrganization(base({ slug: "  Ballona-Creek-TRUST " }), OWNER)
    expect(dto.slug).toBe("ballona-creek-trust")
    expect([...repo.organizations.values()][0]?.slug).toBe("ballona-creek-trust")
    const read = await service.getOrganizationBySlug("BALLONA-Creek-Trust", null)
    expect(read.id).toBe(dto.id)
  })

  it("applies the reserved-word check to the NORMALIZED slug", async () => {
    await expect(service.createOrganization(base({ slug: " ADMIN " }), OWNER)).rejects.toMatchObject({
      code: "VALIDATION",
    })
    expect(repo.organizations.size).toBe(0)
  })

  it("409s a slug that differs from a live one only by case", async () => {
    await service.createOrganization(base(), OWNER)
    await expect(
      service.createOrganization(base({ slug: "Ballona-Creek-Trust" }), ADMIN),
    ).rejects.toMatchObject({ code: "CONFLICT" })
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

  it("never names the account behind an email: a hit is added silently, a miss becomes a pending invite", async () => {
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
    expect(hit).toEqual({ ok: true, member: null, invited: true, invite: null })
    expect(JSON.stringify(hit)).not.toContain("Mel Member")
    expect(miss).toMatchObject({ ok: true, member: null, invited: true })
    expect(miss.invite).toMatchObject({
      organizationId: dto.id,
      email: "nobody@example.com",
      user: null,
      role: "member",
      status: "pending",
      invitedBy: { id: OWNER },
    })
    expect(repo.members.some((m) => m.userId === MEMBER)).toBe(true)
    expect(repo.invites).toHaveLength(1)
  })

  it("returns the new member row for a handle invite (handles are public, so nothing leaks)", async () => {
    const dto = await service.createOrganization(base(), OWNER)
    const result = await service.inviteMember(dto.id, OWNER, {
      identifierKind: "handle",
      identifier: "adam",
      role: "admin",
    })
    expect(result.invited).toBe(true)
    expect(result.member).toMatchObject({
      person: { id: ADMIN, handle: "adam" },
      role: "admin",
      joinedAt: clock.toISOString(),
      canRemove: true,
    })
    const unknown = await service.inviteMember(dto.id, OWNER, {
      identifierKind: "handle",
      identifier: "nobody",
      role: "member",
    })
    expect(unknown).toEqual({ ok: true, member: null, invited: true, invite: null })
    expect(repo.invites).toHaveLength(0)
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

  describe("owner notification", () => {
    interface Sent {
      to: string
      template: string
      vars: Record<string, unknown>
    }
    interface Notified {
      userId: string
      input: { type: string; title: string; body?: string; link?: string }
    }

    function notifying(
      over: { mailer?: boolean; notifier?: boolean; failing?: boolean } = {},
    ): { svc: OrganizationService; mails: Sent[]; notes: Notified[]; warnings: unknown[] } {
      const mails: Sent[] = []
      const notes: Notified[] = []
      const warnings: unknown[] = []
      const svc = makeOrganizationService({
        repo,
        counters: new InMemoryCounterStore(() => clock.getTime()),
        now: () => clock,
        newId: () => randomUUID(),
        webOrigin: "https://web.test/",
        ...(over.mailer === false
          ? {}
          : {
              mailer: {
                sendTransactional: (to, template, vars) => {
                  if (over.failing) return Promise.reject(new Error("smtp down"))
                  mails.push({ to, template, vars })
                  return Promise.resolve()
                },
              },
            }),
        ...(over.notifier === false
          ? {}
          : {
              notifier: {
                createNotification: (userId, input) => {
                  if (over.failing) return Promise.reject(new Error("notifications down"))
                  notes.push({ userId, input })
                  return Promise.resolve()
                },
              },
            }),
        logger: { error: () => undefined, warn: (obj) => warnings.push(obj) },
      })
      return { svc, mails, notes, warnings }
    }

    it("emails + notifies the OWNER (not the admin who applied) on approval", async () => {
      const { svc, mails, notes } = notifying()
      const id = await seeded()
      await svc.applyVerification(id, OWNER, { kind: "nonprofit", documents: [] })
      await svc.adminDecideVerification(id, OPERATOR, { decision: "verified" })

      expect(mails).toHaveLength(1)
      expect(mails[0]).toMatchObject({ to: "olive@x.org", template: "generic" })
      expect(mails[0]?.vars.subject).toBe(
        "Ballona Creek Trust is now verified as a nonprofit on civfix",
      )
      expect(String(mails[0]?.vars.message)).toContain("https://web.test/orgs/ballona-creek-trust")

      expect(notes).toHaveLength(1)
      expect(notes[0]).toMatchObject({
        userId: OWNER,
        input: { type: "system", title: "Ballona Creek Trust is now verified", link: "/orgs/ballona-creek-trust" },
      })
      expect(notes[0]?.userId).not.toBe(ADMIN)
    })

    it("names the granted kind, not the requested one, when the operator overrides it", async () => {
      const { svc, mails } = notifying()
      const id = await seeded()
      await svc.applyVerification(id, OWNER, { kind: "nonprofit", documents: [] })
      await svc.adminDecideVerification(id, OPERATOR, { decision: "verified", kind: "community" })
      expect(mails[0]?.vars.subject).toBe(
        "Ballona Creek Trust is now verified as a community organization on civfix",
      )
    })

    it("includes the rejection reason and how to re-apply on a rejection", async () => {
      const { svc, mails, notes } = notifying()
      const id = await seeded()
      await svc.applyVerification(id, OWNER, { kind: "nonprofit", documents: [] })
      await svc.adminDecideVerification(id, OPERATOR, {
        decision: "rejected",
        reason: "no determination letter",
      })

      expect(mails).toHaveLength(1)
      expect(mails[0]?.to).toBe("olive@x.org")
      expect(mails[0]?.vars.subject).toBe(
        "Your verification application for Ballona Creek Trust was not approved",
      )
      const message = String(mails[0]?.vars.message)
      expect(message).toContain("Reason: no determination letter")
      expect(message).toContain("re-apply")
      expect(message).toContain(`https://web.test/manage/orgs/${id}/verification`)

      expect(notes[0]).toMatchObject({
        userId: OWNER,
        input: { type: "system", link: `/manage/orgs/${id}/verification` },
      })
      expect(notes[0]?.input.body).toContain("no determination letter")
    })

    it("still notifies in-app when the owner has no email address", async () => {
      const { svc, mails, notes } = notifying()
      repo.seedUser({ id: OWNER, displayName: "Olive Owner", handle: "olive", email: null })
      const id = await seeded()
      await svc.applyVerification(id, OWNER, { kind: "community", documents: [] })
      await svc.adminDecideVerification(id, OPERATOR, { decision: "verified" })
      expect(mails).toHaveLength(0)
      expect(notes).toHaveLength(1)
    })

    it("never fails the decision because the owner could not be notified", async () => {
      const { svc, mails, notes, warnings } = notifying({ failing: true })
      const id = await seeded()
      await svc.applyVerification(id, OWNER, { kind: "nonprofit", documents: [] })
      const dto = await svc.adminDecideVerification(id, OPERATOR, { decision: "verified" })
      expect(dto.verifiedStatus).toBe("verified")
      expect(mails).toHaveLength(0)
      expect(notes).toHaveLength(0)
      expect(warnings).toHaveLength(2)
      expect(repo.audits.some((a) => a.action === "org.verification_verified")).toBe(true)
    })

    it("sends nothing for a decision that did not happen", async () => {
      const { svc, mails, notes } = notifying()
      const id = await seeded()
      await expect(
        svc.adminDecideVerification(id, OPERATOR, { decision: "verified" }),
      ).rejects.toMatchObject({ code: "CONFLICT" })
      expect(mails).toHaveLength(0)
      expect(notes).toHaveLength(0)
    })
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

describe("org invites (0.41.0)", () => {
  const OPERATOR_TOKEN = "org-invite-token-0123456789abcdefghijklmnop"
  let mails: { to: string; vars: Record<string, unknown> }[]
  let notes: { userId: string; type: string; title: string }[]

  beforeEach(() => {
    mails = []
    notes = []
    service = makeOrganizationService({
      repo,
      counters: new InMemoryCounterStore(() => clock.getTime()),
      now: () => clock,
      newId: () => randomUUID(),
      newToken: () => OPERATOR_TOKEN,
      webOrigin: "https://civfix.test/",
      mailer: {
        sendTransactional: (to, _template, vars) => {
          mails.push({ to, vars })
          return Promise.resolve()
        },
      },
      notifier: {
        createNotification: (userId, input) => {
          notes.push({ userId, type: input.type, title: input.title })
          return Promise.resolve()
        },
      },
    })
  })

  async function invited(): Promise<{ orgId: string; inviteId: string }> {
    const dto = await service.createOrganization(base(), OWNER)
    const result = await service.inviteMember(dto.id, OWNER, {
      identifierKind: "email",
      identifier: "Newcomer@Example.com",
      role: "admin",
    })
    return { orgId: dto.id, inviteId: result.invite?.id ?? "" }
  }

  it("creates a pending invite, stores only the token hash, and emails the accept link", async () => {
    const { orgId } = await invited()
    const stored = repo.invites[0]
    expect(stored?.email).toBe("newcomer@example.com")
    expect(stored?.tokenHash).not.toContain(OPERATOR_TOKEN)
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored?.expiresAt.getTime()).toBe(clock.getTime() + 14 * 24 * 60 * 60 * 1000)
    expect(mails).toHaveLength(1)
    expect(mails[0]?.to).toBe("newcomer@example.com")
    expect(String(mails[0]?.vars.subject)).toContain("Olive Owner invited you to join Ballona Creek Trust")
    expect(String(mails[0]?.vars.message)).toContain(
      `https://civfix.test/manage/org-invites/accept?token=${OPERATOR_TOKEN}`,
    )
    expect(repo.audits.filter((a) => a.action === "org.invite_created")).toHaveLength(1)
    const listed = await service.listInvites(orgId, OWNER)
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]?.status).toBe("pending")
  })

  it("409s a second open invite to the same address", async () => {
    const { orgId } = await invited()
    await expect(
      service.inviteMember(orgId, OWNER, {
        identifierKind: "email",
        identifier: "newcomer@example.com",
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("accepts with the account that owns the invited email and seats the member", async () => {
    const { orgId } = await invited()
    const newcomer = repo.seedUser({ displayName: "Nia New", email: "newcomer@example.com" })
    const accepted = await service.acceptInvite(newcomer.id, OPERATOR_TOKEN)
    expect(accepted).toMatchObject({ ok: true, role: "admin" })
    expect(accepted.organization).toMatchObject({ id: orgId, myRole: "admin" })
    expect(repo.invites[0]?.status).toBe("accepted")
    expect(repo.invites[0]?.userId).toBe(newcomer.id)
    expect(repo.audits.filter((a) => a.action === "org.invite_accepted")).toHaveLength(1)
    // Single use.
    await expect(service.acceptInvite(newcomer.id, OPERATOR_TOKEN)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("404s (non-probing) an accept from an account whose email does not match", async () => {
    await invited()
    await expect(service.acceptInvite(STRANGER, OPERATOR_TOKEN)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    expect(repo.invites[0]?.status).toBe("pending")
  })

  it("409s an expired invite and marks it expired", async () => {
    await invited()
    const newcomer = repo.seedUser({ email: "newcomer@example.com" })
    clock = new Date(clock.getTime() + 15 * 24 * 60 * 60 * 1000)
    await expect(service.acceptInvite(newcomer.id, OPERATOR_TOKEN)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(repo.invites[0]?.status).toBe("expired")
  })

  it("lists lazily-expired invites as expired, pending first", async () => {
    const { orgId } = await invited()
    clock = new Date(clock.getTime() + 15 * 24 * 60 * 60 * 1000)
    await service.inviteMember(orgId, OWNER, {
      identifierKind: "email",
      identifier: "second@example.com",
      role: "member",
    })
    const listed = await service.listInvites(orgId, OWNER)
    expect(listed.items.map((i) => i.status)).toEqual(["pending", "expired"])
  })

  it("revokes a pending invite so the token no longer accepts", async () => {
    const { orgId, inviteId } = await invited()
    await expect(service.revokeInvite(orgId, OWNER, inviteId)).resolves.toEqual({ ok: true })
    await expect(service.revokeInvite(orgId, OWNER, inviteId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    const newcomer = repo.seedUser({ email: "newcomer@example.com" })
    await expect(service.acceptInvite(newcomer.id, OPERATOR_TOKEN)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("listing invites is owner|admin; a plain member is refused", async () => {
    const { orgId } = await invited()
    await service.inviteMember(orgId, OWNER, { identifierKind: "handle", identifier: "mel", role: "member" })
    await expect(service.listInvites(orgId, MEMBER)).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("caps pending invites per organization", async () => {
    const dto = await service.createOrganization(base(), OWNER)
    for (let i = 0; i < 50; i += 1) {
      repo.invites.push({
        id: randomUUID(),
        organizationId: dto.id,
        email: `p${i}@example.com`,
        userId: null,
        role: "member",
        status: "pending",
        tokenHash: `h${i}`,
        invitedBy: OWNER,
        createdAt: clock,
        expiresAt: new Date(clock.getTime() + 60_000),
        acceptedAt: null,
        revokedAt: null,
      })
    }
    await expect(
      service.inviteMember(dto.id, OWNER, {
        identifierKind: "email",
        identifier: "one-more@example.com",
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("notifies a member added by handle in-app", async () => {
    const dto = await service.createOrganization(base(), OWNER)
    await service.inviteMember(dto.id, OWNER, { identifierKind: "handle", identifier: "adam", role: "admin" })
    expect(notes).toEqual([
      { userId: ADMIN, type: "system", title: "You've been added to Ballona Creek Trust" },
    ])
  })
})

describe("suspension (0.41.0)", () => {
  async function suspended(): Promise<string> {
    const dto = await service.createOrganization(base(), OWNER)
    await service.inviteMember(dto.id, OWNER, { identifierKind: "handle", identifier: "mel", role: "member" })
    await service.adminSetSuspended(dto.id, OPERATOR, { suspended: true, reason: "impersonation" })
    return dto.id
  }

  it("hides the public page from non-members but shows members the flag", async () => {
    await suspended()
    await expect(service.getOrganizationBySlug("ballona-creek-trust", null)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(service.getOrganizationBySlug("ballona-creek-trust", STRANGER)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    const asMember = await service.getOrganizationBySlug("ballona-creek-trust", MEMBER)
    expect(asMember.suspended).toBe(true)
    const mine = await service.listMyOrganizations(OWNER)
    expect(mine[0]?.suspended).toBe(true)
  })

  it("refuses self-service writes while suspended, and lifts cleanly", async () => {
    const id = await suspended()
    await expect(service.updateOrganization(id, { name: "New name" }, OWNER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(
      service.inviteMember(id, OWNER, { identifierKind: "handle", identifier: "adam", role: "admin" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      service.applyVerification(id, OWNER, { kind: "nonprofit", documents: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    // A member can still leave.
    await expect(service.removeMember(id, MEMBER, MEMBER)).resolves.toEqual({ ok: true })

    const lifted = await service.adminSetSuspended(id, OPERATOR, { suspended: false, reason: "resolved" })
    expect(lifted.suspendedAt).toBeNull()
    expect(lifted.verifiedStatus).toBe("unverified")
    await expect(service.updateOrganization(id, { name: "New name" }, OWNER)).resolves.toMatchObject({
      name: "New name",
      suspended: false,
    })
    expect(repo.audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["org.suspended", "org.unsuspended"]),
    )
  })

  it("keeps the admin plane working and reports the flag on the admin DTO", async () => {
    const id = await suspended()
    const dto = await service.adminGetOrganization(id)
    expect(dto.suspendedAt).toBe(clock.toISOString())
    expect(dto.suspendedReason).toBe("impersonation")
    await expect(
      service.adminUpdateOrganization(id, OPERATOR, { name: "Renamed", reason: "cleanup" }),
    ).resolves.toMatchObject({ name: "Renamed" })
    const page = await service.adminListOrganizations({ suspended: true, cursor: null, limit: 25 })
    expect(page.items.map((o) => o.id)).toEqual([id])
    expect(page.counts).toEqual({ all: 1, verified: 0, pending: 0, suspended: 1 })
  })
})

describe("admin org management (0.41.0)", () => {
  async function created(over: Record<string, unknown> = {}) {
    return service.adminCreateOrganization(OPERATOR, {
      name: "City of Playa",
      slug: "City-Of-Playa",
      ownerUserId: OWNER,
      reason: "onboarded at the partner summit",
      ...over,
    } as Parameters<OrganizationService["adminCreateOrganization"]>[1])
  }

  it("creates an org for an owner, already verified when a kind is given, with audit rows", async () => {
    const dto = await created({ verifiedKind: "government" })
    expect(dto).toMatchObject({
      slug: "city-of-playa",
      verifiedStatus: "verified",
      verifiedKind: "government",
      verifiedAt: clock.toISOString(),
      owner: { id: OWNER, handle: "olive" },
      memberCount: 1,
      suspendedAt: null,
      updatedAt: clock.toISOString(),
    })
    expect(dto.verification).toMatchObject({ status: "verified", kind: "government" })
    expect(repo.organizations.get(dto.id)?.createdBy).toBe(OPERATOR)
    expect(repo.members.find((m) => m.organizationId === dto.id)).toMatchObject({
      userId: OWNER,
      role: "owner",
    })
    expect(repo.audits.filter((a) => a.action === "org.created")[0]).toMatchObject({
      actorId: OPERATOR,
      target: `organization:${dto.id}`,
      meta: { reason: "onboarded at the partner summit", ownerUserId: OWNER },
    })
    expect(repo.audits.filter((a) => a.action === "org.verification_verified")[0]).toMatchObject({
      actorId: OPERATOR,
      meta: { kind: "government", reason: "onboarded at the partner summit" },
    })
  })

  it("creates unverified without a kind, and is not bound by the per-host daily cap", async () => {
    for (let i = 0; i < ORGS_CREATED_PER_DAY + 1; i += 1) {
      const dto = await created({ slug: `partner-${i}`, name: `Partner ${i}` })
      expect(dto.verifiedStatus).toBe("unverified")
    }
  })

  it("422s an unknown owner and 409s a taken or reserved slug", async () => {
    await expect(created({ ownerUserId: randomUUID() })).rejects.toMatchObject({
      code: "VALIDATION",
    })
    await created()
    await expect(created()).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(created({ slug: "admin" })).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("lists with search, facets and page-one counts", async () => {
    await created({ verifiedKind: "nonprofit" })
    const second = await created({ slug: "second", name: "Second Org", ownerUserId: ADMIN })
    await service.applyVerification(second.id, ADMIN, { kind: "community", documents: [] })
    const third = await created({ slug: "third", name: "Third Org", ownerUserId: MEMBER })
    await service.adminSetSuspended(third.id, OPERATOR, { suspended: true, reason: "spam" })

    const all = await service.adminListOrganizations({ cursor: null, limit: 25 })
    expect(all.items).toHaveLength(3)
    expect(all.counts).toEqual({ all: 3, verified: 1, pending: 1, suspended: 1 })

    const verified = await service.adminListOrganizations({ verified: "verified", cursor: null, limit: 25 })
    expect(verified.items.map((o) => o.slug)).toEqual(["city-of-playa"])
    const kind = await service.adminListOrganizations({ kind: "nonprofit", cursor: null, limit: 25 })
    expect(kind.items.map((o) => o.slug)).toEqual(["city-of-playa"])
    const q = await service.adminListOrganizations({ q: "third", cursor: null, limit: 25 })
    expect(q.items.map((o) => o.slug)).toEqual(["third"])
    expect(q.counts).toEqual({ all: 1, verified: 0, pending: 0, suspended: 1 })
    const notSuspended = await service.adminListOrganizations({ suspended: false, cursor: null, limit: 25 })
    expect(notSuspended.items).toHaveLength(2)

    const paged = await service.adminListOrganizations({ cursor: null, limit: 2 })
    expect(paged.items).toHaveLength(2)
    expect(paged.nextCursor).not.toBeNull()
    const next = await service.adminListOrganizations({ cursor: paged.nextCursor, limit: 2 })
    expect(next.items).toHaveLength(1)
    expect(next.counts).toBeUndefined()
  })

  it("updates fields including the slug, audits the changed keys, and 409s a taken slug", async () => {
    const a = await created()
    await created({ slug: "other-org", name: "Other", ownerUserId: ADMIN })
    const dto = await service.adminUpdateOrganization(a.id, OPERATOR, {
      name: "City of Playa del Rey",
      slug: "Playa-Del-Rey",
      description: null,
      reason: "renamed department",
    })
    expect(dto).toMatchObject({ name: "City of Playa del Rey", slug: "playa-del-rey" })
    const audit = repo.audits.filter((x) => x.action === "org.updated")
    expect(audit).toHaveLength(1)
    expect(audit[0]?.meta).toEqual({ reason: "renamed department", changed: ["name", "slug"] })
    await expect(
      service.adminUpdateOrganization(a.id, OPERATOR, { slug: "other-org", reason: "x" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(
      service.adminUpdateOrganization(a.id, OPERATOR, { slug: "admin", reason: "x" }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    await expect(
      service.adminUpdateOrganization(randomUUID(), OPERATOR, { name: "x", reason: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("lists members with operator actor refs", async () => {
    const dto = await created()
    await service.adminAddMember(dto.id, OPERATOR, { userId: ADMIN, role: "admin", reason: "staff" })
    const page = await service.adminListMembers(dto.id, { cursor: null, limit: 25 })
    expect(page.items.map((m) => [m.user.handle, m.role])).toEqual([
      ["olive", "owner"],
      ["adam", "admin"],
    ])
    expect(page.items[0]?.user.joined).toBe("2025-01-01T00:00:00.000Z")
  })

  it("adds a member (audited), 409s a duplicate, 422s an unknown user", async () => {
    const dto = await created()
    await expect(
      service.adminAddMember(dto.id, OPERATOR, { userId: MEMBER, role: "member", reason: "asked" }),
    ).resolves.toEqual({ ok: true })
    expect(repo.audits.filter((a) => a.action === "org.member_added")[0]).toMatchObject({
      actorId: OPERATOR,
      meta: { targetUserId: MEMBER, role: "member", reason: "asked" },
    })
    await expect(
      service.adminAddMember(dto.id, OPERATOR, { userId: MEMBER, role: "admin", reason: "again" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(
      service.adminAddMember(dto.id, OPERATOR, { userId: randomUUID(), role: "member", reason: "x" }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("adding as owner transfers ownership: the previous owner becomes admin", async () => {
    const dto = await created()
    await service.adminAddMember(dto.id, OPERATOR, { userId: ADMIN, role: "owner", reason: "handover" })
    const roles = repo.members
      .filter((m) => m.organizationId === dto.id)
      .map((m) => [m.userId, m.role])
    expect(roles).toEqual([
      [OWNER, "admin"],
      [ADMIN, "owner"],
    ])
    expect(repo.audits.filter((a) => a.action === "org.ownership_transferred")[0]?.meta).toEqual({
      from: OWNER,
      to: ADMIN,
      reason: "handover",
    })
  })

  it("setting a member's role to owner transfers; demoting the sole owner is refused", async () => {
    const dto = await created()
    await service.adminAddMember(dto.id, OPERATOR, { userId: ADMIN, role: "member", reason: "x" })
    await expect(
      service.adminSetMemberRole(dto.id, OPERATOR, { userId: OWNER, role: "admin", reason: "x" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(
      service.adminSetMemberRole(dto.id, OPERATOR, { userId: ADMIN, role: "owner", reason: "handover" }),
    ).resolves.toEqual({ ok: true })
    expect(repo.members.find((m) => m.userId === OWNER)?.role).toBe("admin")
    expect(repo.members.find((m) => m.userId === ADMIN)?.role).toBe("owner")
    // Now the old owner can be demoted further and even removed.
    await expect(
      service.adminSetMemberRole(dto.id, OPERATOR, { userId: OWNER, role: "member", reason: "x" }),
    ).resolves.toEqual({ ok: true })
    await expect(
      service.adminSetMemberRole(dto.id, OPERATOR, { userId: STRANGER, role: "member", reason: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("removes a member with the reason audited, but never the owner", async () => {
    const dto = await created()
    await service.adminAddMember(dto.id, OPERATOR, { userId: ADMIN, role: "admin", reason: "x" })
    await expect(
      service.adminRemoveMember(dto.id, OPERATOR, { userId: OWNER, reason: "x" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(
      service.adminRemoveMember(dto.id, OPERATOR, { userId: ADMIN, reason: "left the org" }),
    ).resolves.toEqual({ ok: true })
    expect(repo.audits.filter((a) => a.action === "org.member_removed")[0]?.meta).toMatchObject({
      targetUserId: ADMIN,
      reason: "left the org",
    })
    await expect(
      service.adminRemoveMember(dto.id, OPERATOR, { userId: ADMIN, reason: "again" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})
