import { beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { EventVisibility, OrganizationMemberRole } from "@civfix/shared"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import type { Queryable } from "../../src/db/client.js"
import { requireCapability } from "../../src/services/host/authz.js"
import { InMemoryHostTeamRepository } from "../../src/services/host/host-team-repository.memory.js"
import {
  makeHostTeamService,
  type HostTeamService,
} from "../../src/services/host/host-team-service.js"
import { InMemoryOrganizationRepository } from "../../src/services/host/organization-repository.memory.js"
import {
  makeOrganizationService,
  type OrganizationService,
} from "../../src/services/host/organization-service.js"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { fakeCleanupDTO } from "../helpers/host-team.js"

const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const EVENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const PRIVATE_EVENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const EVENT_ORG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

const ORGANIZER_A = "11111111-1111-4111-8111-111111111111"
const ORGANIZER_B = "22222222-2222-4222-8222-222222222222"
const COHOST_A = "33333333-3333-4333-8333-333333333333"
const STAFF_A = "44444444-4444-4444-8444-444444444444"
const ATTENDEE_A = "55555555-5555-4555-8555-555555555555"
const INVITEE = "66666666-6666-4666-8666-666666666666"
const STRANGER = "77777777-7777-4777-8777-777777777777"
const ORG_ADMIN = "88888888-8888-4888-8888-888888888888"

describe("host team authorization (BE-TEST-033)", () => {
  const visibility = new Map<string, EventVisibility>([
    [EVENT_A, "public"],
    [EVENT_B, "public"],
    [PRIVATE_EVENT, "private"],
  ])
  const eventOrgRoles = new Map<string, OrganizationMemberRole>()

  let repo: InMemoryHostTeamRepository
  let service: HostTeamService
  let tokenSeq: number

  // Production wires deps.standing to authz.requireCapability over SQL (team.routes.ts). Here the same
  // function runs over a fake SQL that answers the standing lookup from the memory repo's seats, so the
  // visibility-then-capability ladder and the capability matrix are the real ones.
  function standingSql(): Queryable {
    return makeFakeSql([
      {
        match: /FROM cleanups c\s+LEFT JOIN cleanup_members m/,
        rows: (values) => {
          const userId = values[0] as string
          const cleanupId = values[2] as string
          const eventVisibility = visibility.get(cleanupId)
          if (eventVisibility === undefined) return []
          const eventRole =
            repo.members.find((m) => m.cleanupId === cleanupId && m.userId === userId)?.role ?? null
          const organizationId = cleanupId === EVENT_A ? EVENT_ORG : null
          return [
            {
              cleanup_id: cleanupId,
              organizer_user_id: cleanupId === EVENT_B ? ORGANIZER_B : ORGANIZER_A,
              organization_id: organizationId,
              visibility: eventVisibility,
              event_role: eventRole,
              org_role: organizationId === null ? null : (eventOrgRoles.get(userId) ?? null),
            },
          ]
        },
      },
    ]).sql as unknown as Queryable
  }

  beforeEach(() => {
    repo = new InMemoryHostTeamRepository()
    eventOrgRoles.clear()
    tokenSeq = 0
    const clock = new Date("2026-09-06T12:00:00.000Z")
    for (const [id, handle] of [
      [ORGANIZER_A, "olive"],
      [ORGANIZER_B, "otto"],
      [COHOST_A, "cody"],
      [STAFF_A, "sasha"],
      [ATTENDEE_A, "ann"],
      [INVITEE, "ida"],
      [STRANGER, "sam"],
    ] as const) {
      repo.seedUser({ id, displayName: handle, handle })
    }
    repo.seedMember(EVENT_A, ORGANIZER_A, "organizer")
    repo.seedMember(EVENT_A, COHOST_A, "cohost")
    repo.seedMember(EVENT_A, STAFF_A, "staff")
    repo.seedMember(EVENT_A, ATTENDEE_A, "member")
    repo.seedMember(EVENT_B, ORGANIZER_B, "organizer")
    repo.seedMember(PRIVATE_EVENT, ORGANIZER_A, "organizer")
    const sql = standingSql()
    service = makeHostTeamService({
      repo,
      standing: (cleanupId, userId, capability) =>
        requireCapability(sql, cleanupId, userId, capability),
      counters: new InMemoryCounterStore(() => clock.getTime()),
      loadEvent: (cleanupId) => Promise.resolve(fakeCleanupDTO(cleanupId)),
      eventTitleOf: () => Promise.resolve("Beach cleanup"),
      webOrigin: "https://civfix.test",
      now: () => clock,
      newToken: () => `token-${++tokenSeq}-aaaaaaaaaaaaaaaaaaaaaaaa`,
      newId: () => randomUUID(),
    })
  })

  async function inviteIda(cleanupId: string, by: string): Promise<{ id: string; token: string }> {
    const { invite } = await service.inviteMember(cleanupId, by, {
      identifierKind: "handle",
      identifier: "ida",
      role: "staff",
    })
    return { id: invite.id, token: `token-${tokenSeq}-aaaaaaaaaaaaaaaaaaaaaaaa` }
  }

  function inviteStatus(inviteId: string): string | undefined {
    return repo.invites.find((i) => i.id === inviteId)?.status
  }

  function seatOf(cleanupId: string, userId: string): string | null {
    return repo.members.find((m) => m.cleanupId === cleanupId && m.userId === userId)?.role ?? null
  }

  it("404s the organizer of A revoking B's invite through A's path, leaving it pending", async () => {
    const ofB = await inviteIda(EVENT_B, ORGANIZER_B)
    await expect(service.revokeInvite(EVENT_A, ORGANIZER_A, ofB.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "That invitation no longer exists.",
    })
    expect(inviteStatus(ofB.id)).toBe("pending")
  })

  it("403s the organizer of A revoking B's invite through B's path", async () => {
    const ofB = await inviteIda(EVENT_B, ORGANIZER_B)
    await expect(service.revokeInvite(EVENT_B, ORGANIZER_A, ofB.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    expect(inviteStatus(ofB.id)).toBe("pending")
  })

  it("403s a cohost revoking their own event's invite (manage_team is organizer-only)", async () => {
    const ofA = await inviteIda(EVENT_A, ORGANIZER_A)
    await expect(service.revokeInvite(EVENT_A, COHOST_A, ofA.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Only the event organizer can manage the team.",
    })
    expect(inviteStatus(ofA.id)).toBe("pending")
  })

  it("lets the organizer revoke their own event's invite", async () => {
    const ofA = await inviteIda(EVENT_A, ORGANIZER_A)
    await expect(service.revokeInvite(EVENT_A, ORGANIZER_A, ofA.id)).resolves.toEqual({ ok: true })
    expect(inviteStatus(ofA.id)).toBe("revoked")
  })

  it("404s B's token accepted on A's path and seats the invitee nowhere", async () => {
    const ofB = await inviteIda(EVENT_B, ORGANIZER_B)
    await expect(service.acceptInvite(EVENT_A, INVITEE, ofB.token)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "That invitation is no longer valid.",
    })
    expect(seatOf(EVENT_A, INVITEE)).toBeNull()
    expect(seatOf(EVENT_B, INVITEE)).toBeNull()
    expect(inviteStatus(ofB.id)).toBe("pending")

    await expect(service.acceptInvite(EVENT_B, INVITEE, ofB.token)).resolves.toEqual({
      ok: true,
      role: "staff",
    })
    expect(seatOf(EVENT_B, INVITEE)).toBe("staff")
  })

  it("403s a plain attendee of a public event reading the team", async () => {
    await expect(service.listTeam(EVENT_A, ATTENDEE_A)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Only the event team can view this.",
    })
  })

  it("403s a stranger on a public event and 404s one on a private event reading the team", async () => {
    await expect(service.listTeam(EVENT_A, STRANGER)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(service.listTeam(PRIVATE_EVENT, STRANGER)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Cleanup not found",
    })
  })

  it("serves the team to event staff and to an org admin of the event's organization", async () => {
    const asStaff = await service.listTeam(EVENT_A, STAFF_A)
    expect(asStaff.members.length).toBeGreaterThan(0)
    eventOrgRoles.set(STRANGER, "admin")
    await expect(service.listTeam(EVENT_A, STRANGER)).resolves.toMatchObject({
      members: expect.any(Array),
    })
  })
})

describe("organization authorization (BE-TEST-034)", () => {
  let repo: InMemoryOrganizationRepository
  let service: OrganizationService

  beforeEach(() => {
    repo = new InMemoryOrganizationRepository()
    for (const [id, handle] of [
      [ORGANIZER_A, "olive"],
      [ORGANIZER_B, "otto"],
      [ORG_ADMIN, "adam"],
      [ATTENDEE_A, "mel"],
      [STRANGER, "sam"],
    ] as const) {
      repo.seedUser({ id, displayName: handle, handle, email: `${handle}@x.org` })
    }
    const clock = new Date("2026-09-06T12:00:00.000Z")
    service = makeOrganizationService({
      repo,
      counters: new InMemoryCounterStore(() => clock.getTime()),
      now: () => clock,
      newId: () => randomUUID(),
    })
  })

  // Org A: ORGANIZER_A owns it, ORG_ADMIN is an admin, ATTENDEE_A a plain member. Org B: ORGANIZER_B
  // owns it alone, so every org A seat is a stranger to org B.
  async function seededOrgs(): Promise<{ orgA: string; orgB: string }> {
    const a = await service.createOrganization(
      { name: "Ballona Creek Trust", slug: "ballona-creek-trust" },
      ORGANIZER_A,
    )
    await service.inviteMember(a.id, ORGANIZER_A, {
      identifierKind: "handle",
      identifier: "adam",
      role: "admin",
    })
    await service.inviteMember(a.id, ORGANIZER_A, {
      identifierKind: "handle",
      identifier: "mel",
      role: "member",
    })
    const b = await service.createOrganization(
      { name: "Venice Beach Friends", slug: "venice-beach-friends" },
      ORGANIZER_B,
    )
    return { orgA: a.id, orgB: b.id }
  }

  function nameOf(id: string): string | undefined {
    return repo.organizations.get(id)?.name
  }

  it("403s a plain member renaming the organization, which keeps its name", async () => {
    const { orgA } = await seededOrgs()
    await expect(
      service.updateOrganization(orgA, { name: "Taken over" }, ATTENDEE_A),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Only the event hosts can edit this event.",
    })
    expect(nameOf(orgA)).toBe("Ballona Creek Trust")
  })

  it("404s a stranger renaming the organization, which keeps its name", async () => {
    const { orgA } = await seededOrgs()
    await expect(
      service.updateOrganization(orgA, { name: "Taken over" }, STRANGER),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Organization not found" })
    expect(nameOf(orgA)).toBe("Ballona Creek Trust")
  })

  it("404s the admin of org A renaming org B, which keeps its name", async () => {
    const { orgB } = await seededOrgs()
    await expect(
      service.updateOrganization(orgB, { name: "Taken over" }, ORG_ADMIN),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(nameOf(orgB)).toBe("Venice Beach Friends")
  })

  it("lets an org admin (not only the owner) rename the organization (pinned current rule)", async () => {
    const { orgA } = await seededOrgs()
    const updated = await service.updateOrganization(orgA, { name: "Renamed by admin" }, ORG_ADMIN)
    expect(updated.name).toBe("Renamed by admin")
    expect(nameOf(orgA)).toBe("Renamed by admin")
  })

  it("404s a stranger reading verification and serves it to any member (pinned)", async () => {
    const { orgA } = await seededOrgs()
    await expect(service.getVerification(orgA, STRANGER)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Organization not found",
    })
    await expect(service.getVerification(orgA, ATTENDEE_A)).resolves.toMatchObject({
      status: expect.any(String),
    })
  })

  it("403s an org admin and 404s a stranger applying for verification", async () => {
    const { orgA } = await seededOrgs()
    const input = { kind: "nonprofit" as const, einNumber: "12-3456789", documents: [] }
    await expect(service.applyVerification(orgA, ORG_ADMIN, input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(service.applyVerification(orgA, STRANGER, input)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("404s the owner of org A changing a member role in org B", async () => {
    const { orgB } = await seededOrgs()
    await expect(
      service.setMemberRole(orgB, ORGANIZER_A, ORGANIZER_B, "admin"),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Organization not found" })
    expect(
      repo.members.find((m) => m.organizationId === orgB && m.userId === ORGANIZER_B)?.role,
    ).toBe("owner")
  })
})
