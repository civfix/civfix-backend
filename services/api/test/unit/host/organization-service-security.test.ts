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

describe("an invite whose inviter lost the power to invite", () => {
  function seatOf(orgId: string, userId: string) {
    return repo.members.find((m) => m.organizationId === orgId && m.userId === userId)
  }

  it("does not seat anyone when the inviter was demoted without the invite being withdrawn", async () => {
    const id = await orgWithAdmin()
    const inviteId = await inviteAs(id, ADMIN, SOCK_EMAIL)
    const adminSeat = seatOf(id, ADMIN)
    if (adminSeat === undefined) throw new Error("expected the admin seat")
    adminSeat.role = "member"

    await expect(service.acceptMyInvite(SOCK, inviteId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })

    expect(seatOf(id, SOCK)).toBeUndefined()
    expect(statusOf(inviteId)).toBe("revoked")
    expect(repo.audits).toContainEqual({
      actorId: SOCK,
      action: "org.invite_revoked",
      target: `organization:${id}`,
      meta: { inviteId, reason: "inviter_demoted" },
    })
  })

  it("names the reason: a removed inviter and a closed inviter account", async () => {
    const id = await orgWithAdmin()
    await service.setMemberRole(id, OWNER, MEMBER, "admin")
    const byRemoved = await inviteAs(id, ADMIN, SOCK_EMAIL)
    const byDeleted = await inviteAs(id, MEMBER, "other@x.org")
    repo.seedUser({ id: OPERATOR, displayName: "Other", email: "other@x.org" })
    repo.members.splice(
      repo.members.findIndex((m) => m.organizationId === id && m.userId === ADMIN),
      1,
    )
    const deleted = repo.users.get(MEMBER)
    if (deleted === undefined) throw new Error("expected the member account")
    deleted.deletedAt = clock

    await expect(service.acceptMyInvite(SOCK, byRemoved)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(service.acceptMyInvite(OPERATOR, byDeleted)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })

    const reasons = repo.audits
      .filter((a) => a.action === "org.invite_revoked")
      .map((a) => [a.meta?.inviteId, a.meta?.reason])
    expect(reasons).toEqual([
      [byRemoved, "inviter_removed"],
      [byDeleted, "account_deleted"],
    ])
    expect(seatOf(id, SOCK)).toBeUndefined()
    expect(seatOf(id, OPERATOR)).toBeUndefined()
  })

  it("still seats the invitee when the inviter keeps the power to invite", async () => {
    const id = await orgWithAdmin()
    const inviteId = await inviteAs(id, ADMIN, SOCK_EMAIL)

    await service.acceptMyInvite(SOCK, inviteId)

    expect(seatOf(id, SOCK)?.role).toBe("admin")
    expect(statusOf(inviteId)).toBe("accepted")
  })

  it("refuses to create an invite or seat a handle once the actor lost the power in between", async () => {
    const id = await orgWithAdmin()
    const findOrganizationById = repo.findOrganizationById.bind(repo)
    repo.findOrganizationById = async (orgId, viewerId) => {
      const record = await findOrganizationById(orgId, viewerId)
      return record === null ? null : { ...record, myRole: "admin" }
    }

    await expect(inviteAs(id, MEMBER, SOCK_EMAIL)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(
      service.inviteMember(id, MEMBER, {
        identifierKind: "handle",
        identifier: "sock",
        role: "admin",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })

    expect(repo.invites.filter((i) => i.organizationId === id)).toEqual([])
    expect(seatOf(id, SOCK)).toBeUndefined()
  })
})

describe("invite SQL under the organization lock", () => {
  const INVITE = "88888888-8888-4888-8888-888888888888"
  const ORG_LOCK = /FROM organizations\s+WHERE id = \?.*FOR UPDATE/s
  const ACTOR_ROLE = /SELECT role FROM organization_members/
  const FUTURE = new Date("2026-09-20T12:00:00.000Z")
  const AUDIT: SqlHandler = { match: /INSERT INTO audit_log/, rows: [{ id: "audit-1" }] }

  function indexOf(statements: { sql: string }[], pattern: RegExp): number {
    return statements.findIndex((s) => pattern.test(s.sql))
  }

  const inviteRow = {
    id: INVITE,
    organization_id: ORG,
    email: SOCK_EMAIL,
    role: "admin",
    status: "pending",
    created_at: clock,
    expires_at: FUTURE,
    user_id: null,
    user_name: null,
    user_handle: null,
    user_bio: null,
    user_avatar_url: null,
    invited_by_id: ADMIN,
    invited_by_name: "Adam Admin",
    invited_by_handle: "adam",
    invited_by_bio: null,
    invited_by_avatar_url: null,
  }

  function createArgs() {
    return {
      inviteId: INVITE,
      organizationId: ORG,
      email: SOCK_EMAIL,
      userId: null,
      role: "admin" as const,
      tokenHash: "hash",
      invitedBy: ADMIN,
      expiresAt: FUTURE,
      now: clock,
    }
  }

  it("creates an invite only after locking the org and re-reading the inviter's role", async () => {
    const fake = makeFakeSql([
      { match: ACTOR_ROLE, rows: [{ role: "admin" }] },
      { match: /INSERT INTO organization_invites/, rows: [{ id: INVITE }] },
      { match: /FROM organization_invites i/, rows: [{ ...inviteRow, created_at: clock }] },
      AUDIT,
    ])

    const outcome = await makeDrizzleOrganizationRepository(
      fake.sql as unknown as Sql,
    ).createInviteTx(createArgs())

    expect(outcome.kind).toBe("created")
    const lock = indexOf(fake.statements, ORG_LOCK)
    const role = indexOf(fake.statements, ACTOR_ROLE)
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(role).toBeGreaterThan(lock)
    expect(indexOf(fake.statements, /INSERT INTO organization_invites/)).toBeGreaterThan(role)
    expect(fake.statements[role]?.values).toEqual(expect.arrayContaining([ORG, ADMIN]))
  })

  it("refuses an invite from an actor who is no longer an admin inside the transaction", async () => {
    const fake = makeFakeSql([{ match: ACTOR_ROLE, rows: [{ role: "member" }] }])

    const outcome = await makeDrizzleOrganizationRepository(
      fake.sql as unknown as Sql,
    ).createInviteTx(createArgs())

    expect(outcome).toEqual({ kind: "forbidden" })
    expect(indexOf(fake.statements, /INSERT INTO organization_invites/)).toBe(-1)
  })

  it("seats a handle only after locking the org and re-reading the actor's role", async () => {
    const allowed = makeFakeSql([
      { match: ACTOR_ROLE, rows: [{ role: "owner" }] },
      { match: /INSERT INTO organization_members/, rows: [{ user_id: SOCK }] },
      AUDIT,
    ])
    const args = { organizationId: ORG, userId: SOCK, role: "admin" as const, actorId: OWNER }

    await expect(
      makeDrizzleOrganizationRepository(allowed.sql as unknown as Sql).addMemberTx({
        ...args,
        now: clock,
      }),
    ).resolves.toBe("added")
    const lock = indexOf(allowed.statements, ORG_LOCK)
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(indexOf(allowed.statements, ACTOR_ROLE)).toBeGreaterThan(lock)

    const refused = makeFakeSql([{ match: ACTOR_ROLE, rows: [] }])
    await expect(
      makeDrizzleOrganizationRepository(refused.sql as unknown as Sql).addMemberTx({
        ...args,
        now: clock,
      }),
    ).resolves.toBe("forbidden")
    expect(indexOf(refused.statements, /INSERT INTO organization_members/)).toBe(-1)
  })

  function acceptHandlers(inviter: { role: string | null; deleted: boolean }[]): SqlHandler[] {
    return [
      { match: /LEFT JOIN organization_members m/, rows: inviter },
      {
        match: /SELECT id, organization_id FROM organization_invites/,
        rows: [{ id: INVITE, organization_id: ORG }],
      },
      { match: /FROM organizations/, rows: [{ id: ORG, suspended: false }] },
      {
        match: /FROM organization_invites\s+WHERE id = \?\s+LIMIT 1 FOR UPDATE/,
        rows: [
          {
            id: INVITE,
            email: null,
            user_id: SOCK,
            role: "admin",
            status: "pending",
            expires_at: FUTURE,
            invited_by: ADMIN,
          },
        ],
      },
      AUDIT,
    ]
  }

  it("answers invalid and revokes the invite when the inviter was demoted", async () => {
    const fake = makeFakeSql(acceptHandlers([{ role: "member", deleted: false }]))

    const outcome = await makeDrizzleOrganizationRepository(
      fake.sql as unknown as Sql,
    ).acceptInviteTx({ by: { inviteId: INVITE }, userId: SOCK, now: clock })

    expect(outcome).toEqual({ kind: "invalid" })
    expect(indexOf(fake.statements, /INSERT INTO organization_members/)).toBe(-1)
    const revoke = fake.statements.find((s) =>
      /UPDATE organization_invites\s+SET status = 'revoked'/.test(s.sql),
    )
    expect(revoke?.values).toEqual(expect.arrayContaining([INVITE]))
    const audit = fake.statements.find((s) => /INSERT INTO audit_log/.test(s.sql))
    expect(audit?.values).toContainEqual({ inviteId: INVITE, reason: "inviter_demoted" })
    expect(indexOf(fake.statements, /LEFT JOIN organization_members m/)).toBeGreaterThan(
      indexOf(fake.statements, ORG_LOCK),
    )
  })

  it("seats the invitee when the inviter still holds an admin seat", async () => {
    const fake = makeFakeSql([
      { match: /INSERT INTO organization_members/, rows: [{ user_id: SOCK }] },
      ...acceptHandlers([{ role: "admin", deleted: false }]),
    ])

    const outcome = await makeDrizzleOrganizationRepository(
      fake.sql as unknown as Sql,
    ).acceptInviteTx({ by: { inviteId: INVITE }, userId: SOCK, now: clock })

    expect(outcome).toMatchObject({ kind: "accepted", role: "admin", alreadyMember: false })
  })
})

describe("inviter revocation writes its audit rows in the same statement", () => {
  it("revokes and audits every pending invite of the inviter with one statement", async () => {
    const fake = makeFakeSql([
      { match: /SELECT role FROM organization_members/, rows: [{ role: "admin" }] },
      { match: /count\(\*\)::int AS n\s+FROM organization_members/, rows: [{ n: 2 }] },
      { match: /DELETE FROM organization_members/, rows: [{ role: "admin" }] },
      { match: /UPDATE organization_invites/, rows: [{ id: "invite-1" }, { id: "invite-2" }] },
      { match: /INSERT INTO audit_log/, rows: [{ id: "audit-1" }] },
    ])

    await makeDrizzleOrganizationRepository(fake.sql as unknown as Sql).removeMemberTx({
      organizationId: ORG,
      userId: ADMIN,
      actorId: OWNER,
    })

    const revoking = fake.statements.filter((s) => /UPDATE organization_invites/.test(s.sql))
    expect(revoking).toHaveLength(1)
    const stmt = revoking[0]!
    expect(stmt.sql).toMatch(/INSERT INTO audit_log/)
    expect(stmt.sql).toMatch(/'org\.invite_revoked'/)
    expect(stmt.values).toEqual(expect.arrayContaining([ORG, ADMIN, OWNER, "inviter_removed"]))
    const perInviteAudits = fake.statements.filter(
      (s) => /INSERT INTO audit_log/.test(s.sql) && s.values.includes("org.invite_revoked"),
    )
    expect(perInviteAudits).toEqual([])
  })
})
