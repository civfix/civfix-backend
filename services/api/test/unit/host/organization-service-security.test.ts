import { beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { InMemoryOrganizationRepository } from "../../../src/services/host/organization-repository.memory.js"
import { makeDrizzleOrganizationRepository } from "../../../src/services/host/organization-repository.drizzle.js"
import {
  makeOrganizationService,
  type OrganizationService,
} from "../../../src/services/host/organization-service.js"
import { makeFakeSql, type SqlHandler } from "../../helpers/fake-sql.js"
import type { Sql } from "../../../src/db/client.js"

const OWNER = "11111111-1111-4111-8111-111111111111"
const ADMIN = "22222222-2222-4222-8222-222222222222"
const MEMBER = "33333333-3333-4333-8333-333333333333"
const SOCK = "44444444-4444-4444-8444-444444444444"
const OPERATOR = "55555555-5555-4555-8555-555555555555"
const ORG = "77777777-7777-4777-8777-777777777777"

const SOCK_EMAIL = "sock@x.org"
const TOKEN_PREFIX = "org-invite-security-token-0123456789abcdefghij"
const INTERNAL_REASON = "fraud report from Jane Reporter"
const SUSPENDED_COPY = "This organization has been suspended, so it can't be changed right now."

let repo: InMemoryOrganizationRepository
let service: OrganizationService
let clock: Date
let minted: number

beforeEach(() => {
  repo = new InMemoryOrganizationRepository()
  repo.seedUser({ id: OWNER, displayName: "Olive Owner", handle: "olive", email: "olive@x.org" })
  repo.seedUser({ id: ADMIN, displayName: "Adam Admin", handle: "adam", email: "adam@x.org" })
  repo.seedUser({ id: MEMBER, displayName: "Mel Member", handle: "mel", email: "mel@x.org" })
  repo.seedUser({ id: SOCK, displayName: "Sock Puppet", handle: "sock", email: SOCK_EMAIL })
  clock = new Date("2026-09-06T12:00:00.000Z")
  minted = 0
  service = makeOrganizationService({
    repo,
    counters: new InMemoryCounterStore(() => clock.getTime()),
    now: () => clock,
    newId: () => randomUUID(),
    newToken: () => {
      minted += 1
      return `${TOKEN_PREFIX}-${minted}`
    },
    webOrigin: "https://civfix.test/",
    presignLogo: (key) => Promise.resolve(`https://cdn.test/${key}`),
  })
})

async function orgWithAdmin(slug = "ballona-creek-trust"): Promise<string> {
  const dto = await service.createOrganization(
    { name: `Org ${slug}`, slug } as Parameters<OrganizationService["createOrganization"]>[0],
    OWNER,
  )
  await service.inviteMember(dto.id, OWNER, {
    identifierKind: "handle",
    identifier: "adam",
    role: "admin",
  })
  await service.inviteMember(dto.id, OWNER, {
    identifierKind: "handle",
    identifier: "mel",
    role: "member",
  })
  return dto.id
}

async function inviteAs(orgId: string, inviterId: string, email: string): Promise<string> {
  const result = await service.inviteMember(orgId, inviterId, {
    identifierKind: "email",
    identifier: email,
    role: "admin",
  })
  return result.invite?.id ?? ""
}

function statusOf(inviteId: string): string | undefined {
  return repo.invites.find((i) => i.id === inviteId)?.status
}

describe("suspension copy", () => {
  it("never shows members the operator's internal suspension reason", async () => {
    const id = await orgWithAdmin()
    await service.adminSetSuspended(id, OPERATOR, { suspended: true, reason: INTERNAL_REASON })

    const refusals = [
      () => service.updateOrganization(id, { name: "New name" }, OWNER),
      () =>
        service.inviteMember(id, ADMIN, {
          identifierKind: "handle",
          identifier: "sock",
          role: "member",
        }),
    ]

    for (const refused of refusals) {
      await expect(refused()).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: SUSPENDED_COPY,
      })
    }
  })
})

describe("pending invites of a departing or demoted inviter", () => {
  it("revokes an admin's pending invites when the owner removes them, so the link no longer seats anyone", async () => {
    const id = await orgWithAdmin()
    const inviteId = await inviteAs(id, ADMIN, SOCK_EMAIL)

    await service.removeMember(id, OWNER, ADMIN)

    expect(statusOf(inviteId)).toBe("revoked")
    expect(repo.invites.find((i) => i.id === inviteId)?.revokedAt).toBeInstanceOf(Date)
    expect(repo.audits).toContainEqual({
      actorId: OWNER,
      action: "org.invite_revoked",
      target: `organization:${id}`,
      meta: { inviteId, reason: "inviter_removed" },
    })
    await expect(service.acceptMyInvite(SOCK, inviteId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    expect(repo.members.some((m) => m.organizationId === id && m.userId === SOCK)).toBe(false)
  })

  it("revokes them when the admin leaves on their own", async () => {
    const id = await orgWithAdmin()
    await service.setMemberRole(id, OWNER, MEMBER, "admin")
    const inviteId = await inviteAs(id, ADMIN, SOCK_EMAIL)

    await service.removeMember(id, ADMIN, ADMIN)

    expect(statusOf(inviteId)).toBe("revoked")
  })

  it("revokes them when the owner demotes the admin to member", async () => {
    const id = await orgWithAdmin()
    const inviteId = await inviteAs(id, ADMIN, SOCK_EMAIL)

    await service.setMemberRole(id, OWNER, ADMIN, "member")

    expect(statusOf(inviteId)).toBe("revoked")
    expect(repo.audits).toContainEqual({
      actorId: OWNER,
      action: "org.invite_revoked",
      target: `organization:${id}`,
      meta: { inviteId, reason: "inviter_demoted" },
    })
  })

  it("revokes them on an operator demotion and an operator removal", async () => {
    const id = await orgWithAdmin()
    await service.setMemberRole(id, OWNER, MEMBER, "admin")
    const demotedInvite = await inviteAs(id, ADMIN, SOCK_EMAIL)
    const removedInvite = await inviteAs(id, MEMBER, "other@x.org")

    await service.adminSetMemberRole(id, OPERATOR, {
      userId: ADMIN,
      role: "member",
      reason: "policy",
    })
    await service.adminRemoveMember(id, OPERATOR, { userId: MEMBER, reason: "policy" })

    expect(statusOf(demotedInvite)).toBe("revoked")
    expect(statusOf(removedInvite)).toBe("revoked")
  })

  it("leaves other inviters' invites, the same inviter's invites in another org, and closed invites alone", async () => {
    const id = await orgWithAdmin()
    const other = await orgWithAdmin("second-trust")
    const ownerInvite = await inviteAs(id, OWNER, "owner-pick@x.org")
    const elsewhere = await inviteAs(other, ADMIN, "elsewhere@x.org")
    const accepted = await inviteAs(id, ADMIN, SOCK_EMAIL)
    await service.acceptMyInvite(SOCK, accepted)

    await service.removeMember(id, OWNER, ADMIN)

    expect(statusOf(ownerInvite)).toBe("pending")
    expect(statusOf(elsewhere)).toBe("pending")
    expect(statusOf(accepted)).toBe("accepted")
  })

  it("keeps the invites of a member promoted to admin, and of an admin whose demotion is refused", async () => {
    const id = await orgWithAdmin()
    const inviteId = await inviteAs(id, ADMIN, SOCK_EMAIL)
    const ownerSeat = repo.members.findIndex((m) => m.organizationId === id && m.role === "owner")
    repo.members.splice(ownerSeat, 1)

    await expect(
      repo.setMemberRoleTx({ organizationId: id, userId: ADMIN, role: "member", actorId: ADMIN }),
    ).resolves.toBe("last_admin")
    await expect(service.removeMember(id, ADMIN, ADMIN)).rejects.toMatchObject({
      code: "VALIDATION",
    })
    await repo.setMemberRoleTx({
      organizationId: id,
      userId: MEMBER,
      role: "admin",
      actorId: ADMIN,
    })

    expect(statusOf(inviteId)).toBe("pending")
  })
})

describe("inviter-revocation SQL", () => {
  function handlers(role: string, seats: number): SqlHandler[] {
    return [
      { match: /SELECT role FROM organization_members/, rows: [{ role }] },
      { match: /count\(\*\)::int AS n\s+FROM organization_members/, rows: [{ n: seats }] },
      { match: /DELETE FROM organization_members/, rows: [{ role }] },
      { match: /UPDATE organization_invites/, rows: [{ id: "invite-1" }] },
      { match: /INSERT INTO audit_log/, rows: [{ id: "audit-1" }] },
    ]
  }

  function indexOf(statements: { sql: string }[], pattern: RegExp): number {
    return statements.findIndex((s) => pattern.test(s.sql))
  }

  const REVOKE = /UPDATE organization_invites\s+SET status = 'revoked'/
  const ORG_LOCK = /FROM organizations WHERE id = \?.*FOR UPDATE/s

  it("revokes the removed member's pending invites in the same transaction, after the org lock", async () => {
    const fake = makeFakeSql(handlers("admin", 2))

    const outcome = await makeDrizzleOrganizationRepository(
      fake.sql as unknown as Sql,
    ).removeMemberTx({ organizationId: ORG, userId: ADMIN, actorId: OWNER })

    expect(outcome).toBe("removed")
    const revoke = indexOf(fake.statements, REVOKE)
    expect(revoke).toBeGreaterThan(indexOf(fake.statements, ORG_LOCK))
    expect(revoke).toBeGreaterThan(indexOf(fake.statements, /DELETE FROM organization_members/))
    const stmt = fake.statements[revoke]!
    expect(stmt.sql).toMatch(/organization_id = \?/)
    expect(stmt.sql).toMatch(/invited_by = \?/)
    expect(stmt.sql).toMatch(/status = 'pending'/)
    expect(stmt.values).toEqual(expect.arrayContaining([ORG, ADMIN]))
  })

  it("revokes on an admin-to-member demotion and not when the demotion is refused", async () => {
    const allowed = makeFakeSql(handlers("admin", 2))
    await makeDrizzleOrganizationRepository(allowed.sql as unknown as Sql).setMemberRoleTx({
      organizationId: ORG,
      userId: ADMIN,
      role: "member",
      actorId: OWNER,
    })
    expect(indexOf(allowed.statements, REVOKE)).toBeGreaterThan(0)

    const refused = makeFakeSql(handlers("admin", 1))
    const outcome = await makeDrizzleOrganizationRepository(
      refused.sql as unknown as Sql,
    ).setMemberRoleTx({ organizationId: ORG, userId: ADMIN, role: "member", actorId: OWNER })
    expect(outcome).toBe("last_admin")
    expect(indexOf(refused.statements, REVOKE)).toBe(-1)
  })

  it("revokes on an operator demotion but not on a promotion", async () => {
    const demoted = makeFakeSql(handlers("admin", 2))
    await makeDrizzleOrganizationRepository(demoted.sql as unknown as Sql).adminSetMemberRoleTx({
      organizationId: ORG,
      userId: ADMIN,
      role: "member",
      actorId: OPERATOR,
      reason: "policy",
      now: clock,
    })
    expect(indexOf(demoted.statements, REVOKE)).toBeGreaterThan(0)

    const promoted = makeFakeSql(handlers("member", 2))
    await makeDrizzleOrganizationRepository(promoted.sql as unknown as Sql).adminSetMemberRoleTx({
      organizationId: ORG,
      userId: MEMBER,
      role: "admin",
      actorId: OPERATOR,
      reason: "policy",
      now: clock,
    })
    expect(indexOf(promoted.statements, REVOKE)).toBe(-1)
  })
})
