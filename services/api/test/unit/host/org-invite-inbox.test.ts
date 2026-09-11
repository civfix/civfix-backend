import { beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { InMemoryOrganizationRepository } from "../../../src/services/host/organization-repository.memory.js"
import {
  makeOrganizationService,
  type OrganizationService,
} from "../../../src/services/host/organization-service.js"

const OWNER = "11111111-1111-4111-8111-111111111111"
const INVITEE = "22222222-2222-4222-8222-222222222222"
const OUTSIDER = "33333333-3333-4333-8333-333333333333"

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

/** Owner creates an org and emails an invite to the invitee's verified address. */
async function invited(): Promise<{ organizationId: string; inviteId: string }> {
  const dto = await service.createOrganization(base(), OWNER)
  await service.inviteMember(dto.id, OWNER, {
    identifierKind: "email",
    identifier: "invitee@x.org",
    role: "member",
  })
  const invite = repo.invites[repo.invites.length - 1]!
  return { organizationId: dto.id, inviteId: invite.id }
}

beforeEach(() => {
  repo = new InMemoryOrganizationRepository()
  repo.seedUser({ id: OWNER, displayName: "Olive Owner", handle: "olive", email: "olive@x.org" })
  repo.seedUser({
    id: INVITEE,
    displayName: "Ivy Invitee",
    handle: "ivy",
    email: "invitee@x.org",
  })
  repo.seedUser({ id: OUTSIDER, displayName: "Sam Stranger", handle: "sam", email: "sam@x.org" })
  clock = new Date("2026-09-10T12:00:00.000Z")
  service = makeOrganizationService({
    repo,
    counters: new InMemoryCounterStore(() => clock.getTime()),
    now: () => clock,
    newId: () => randomUUID(),
    presignLogo: (key) => Promise.resolve(`https://cdn.test/${key}`),
  })
})

describe("listMyOrgInvites", () => {
  it("lists the open invite addressed to the viewer's verified address, with the org badge", async () => {
    const { organizationId } = await invited()
    const { items } = await service.listMyInvites(INVITEE)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      role: "member",
      organization: { id: organizationId, slug: "ballona-creek-trust" },
      invitedBy: { id: OWNER, handle: "olive" },
    })
    expect(items[0]!.expiresAt).toBeTypeOf("string")
  })

  it("carries no email field: the reader knows their own address and cannot be shown another", async () => {
    await invited()
    const { items } = await service.listMyInvites(INVITEE)
    expect(Object.keys(items[0]!)).not.toContain("email")
  })

  it("shows nothing to an account the invite is not addressed to (no oracle)", async () => {
    await invited()
    expect(await service.listMyInvites(OUTSIDER)).toEqual({ items: [] })
  })

  it("hides an invite whose address the account has NOT verified", async () => {
    repo.seedUser({
      id: OUTSIDER,
      displayName: "Sam Stranger",
      handle: "sam",
      email: "invitee@x.org",
      emailVerified: false,
    })
    await invited()
    expect(await service.listMyInvites(OUTSIDER)).toEqual({ items: [] })
  })

  it("drops an expired invite from the inbox", async () => {
    await invited()
    clock = new Date("2026-11-01T12:00:00.000Z")
    expect(await service.listMyInvites(INVITEE)).toEqual({ items: [] })
  })

  it("drops the invite once the viewer is already seated", async () => {
    const { inviteId } = await invited()
    await service.acceptMyInvite(INVITEE, inviteId)
    expect(await service.listMyInvites(INVITEE)).toEqual({ items: [] })
  })

  it("drops an invite from a suspended organization", async () => {
    const { organizationId } = await invited()
    await service.adminSetSuspended(organizationId, OWNER, {
      suspended: true,
      reason: "under review",
    })
    expect(await service.listMyInvites(INVITEE)).toEqual({ items: [] })
  })
})

describe("acceptMyOrgInvite", () => {
  it("seats the invitee and closes the invite, exactly like the emailed token path", async () => {
    const { organizationId, inviteId } = await invited()
    const res = await service.acceptMyInvite(INVITEE, inviteId)
    expect(res).toMatchObject({ ok: true, role: "member" })
    expect(res.organization.id).toBe(organizationId)
    expect(repo.members.some((m) => m.organizationId === organizationId && m.userId === INVITEE))
      .toBe(true)
    expect(repo.invites.find((i) => i.id === inviteId)?.status).toBe("accepted")
  })

  it("404s the same way for an unknown id and for someone else's invite (no oracle)", async () => {
    const { inviteId } = await invited()
    await expect(service.acceptMyInvite(OUTSIDER, inviteId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(service.acceptMyInvite(OUTSIDER, randomUUID())).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    expect(repo.invites.find((i) => i.id === inviteId)?.status).toBe("pending")
  })

  it("409s an expired invite and names the expiry", async () => {
    const { inviteId } = await invited()
    clock = new Date("2026-11-01T12:00:00.000Z")
    await expect(service.acceptMyInvite(INVITEE, inviteId)).rejects.toMatchObject({
      code: "CONFLICT",
    })
  })

  it("409s an invite to a suspended organization rather than seating anyone", async () => {
    const { organizationId, inviteId } = await invited()
    await service.adminSetSuspended(organizationId, OWNER, {
      suspended: true,
      reason: "under review",
    })
    await expect(service.acceptMyInvite(INVITEE, inviteId)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(repo.members.some((m) => m.userId === INVITEE)).toBe(false)
  })

  it("is a no-op the second time: the invite is already terminal", async () => {
    const { inviteId } = await invited()
    await service.acceptMyInvite(INVITEE, inviteId)
    await expect(service.acceptMyInvite(INVITEE, inviteId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })
})

describe("declineMyOrgInvite", () => {
  it("marks the invite declined, seats nobody, and audits it", async () => {
    const { organizationId, inviteId } = await invited()
    expect(await service.declineMyInvite(INVITEE, inviteId)).toEqual({ ok: true })
    expect(repo.invites.find((i) => i.id === inviteId)?.status).toBe("declined")
    expect(repo.members.some((m) => m.organizationId === organizationId && m.userId === INVITEE))
      .toBe(false)
    expect(repo.audits.some((a) => a.action === "org.invite_declined")).toBe(true)
  })

  it("is terminal: declining twice 404s, and the inbox no longer lists it", async () => {
    const { inviteId } = await invited()
    await service.declineMyInvite(INVITEE, inviteId)
    await expect(service.declineMyInvite(INVITEE, inviteId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    expect(await service.listMyInvites(INVITEE)).toEqual({ items: [] })
  })

  it("does not blocklist: the organization may invite the same address again", async () => {
    const { organizationId, inviteId } = await invited()
    await service.declineMyInvite(INVITEE, inviteId)
    await service.inviteMember(organizationId, OWNER, {
      identifierKind: "email",
      identifier: "invitee@x.org",
      role: "member",
    })
    const { items } = await service.listMyInvites(INVITEE)
    expect(items).toHaveLength(1)
    expect(items[0]!.id).not.toBe(inviteId)
  })

  it("404s someone else's invite and leaves it pending", async () => {
    const { inviteId } = await invited()
    await expect(service.declineMyInvite(OUTSIDER, inviteId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    expect(repo.invites.find((i) => i.id === inviteId)?.status).toBe("pending")
  })
})
