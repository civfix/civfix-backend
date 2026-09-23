import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { testHandle, withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleOrganizationRepository } from "../../src/services/host/organization-repository.drizzle.js"
import type { OrganizationRepository } from "../../src/services/host/organization-repository.types.js"

const pg = await withPg()
const INVITE_TTL_MS = 14 * 86_400_000

describe.skipIf(!pg)("organization invite revocation (integration)", () => {
  let h: PgHarness
  let orgs: OrganizationRepository

  beforeAll(() => {
    h = pg as PgHarness
    orgs = makeDrizzleOrganizationRepository(h.sql)
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${testHandle()}) RETURNING id
    `
    return (u as { id: string }).id
  }

  async function newOrg(ownerId: string): Promise<string> {
    const slug = `sec-${randomUUID().slice(0, 8)}`
    const created = await orgs.createOrganizationTx({
      organizationId: randomUUID(),
      slug,
      name: `Org ${slug}`,
      description: null,
      websiteUrl: null,
      logoMediaId: null,
      socialLinks: null,
      createdBy: ownerId,
      now: new Date(),
    })
    if (created === "slug_taken") throw new Error(`slug ${slug} unexpectedly taken`)
    return created.id
  }

  async function seat(organizationId: string, userId: string, role: "admin" | "member") {
    await h.sql`
      INSERT INTO organization_members (organization_id, user_id, role)
      VALUES (${organizationId}, ${userId}, ${role})
    `
  }

  async function invite(organizationId: string, invitedBy: string): Promise<string> {
    const now = new Date()
    const outcome = await orgs.createInviteTx({
      inviteId: randomUUID(),
      organizationId,
      email: `${randomUUID().slice(0, 8)}@example.test`,
      userId: null,
      role: "admin",
      tokenHash: randomUUID().replace(/-/g, ""),
      invitedBy,
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      now,
    })
    return outcome.invite.id
  }

  async function statusOf(inviteId: string): Promise<{ status: string; revoked: boolean }> {
    const rows = await h.sql<{ status: string; revoked_at: Date | null }[]>`
      SELECT status, revoked_at FROM organization_invites WHERE id = ${inviteId}
    `
    const row = rows[0] as { status: string; revoked_at: Date | null }
    return { status: row.status, revoked: row.revoked_at !== null }
  }

  it("revokes a removed admin's pending invites and audits each one", async () => {
    const owner = await newUser("Owner")
    const admin = await newUser("Admin")
    const orgId = await newOrg(owner)
    await seat(orgId, admin, "admin")
    const byAdmin = await invite(orgId, admin)
    const byOwner = await invite(orgId, owner)

    await expect(
      orgs.removeMemberTx({ organizationId: orgId, userId: admin, actorId: owner }),
    ).resolves.toBe("removed")

    expect(await statusOf(byAdmin)).toEqual({ status: "revoked", revoked: true })
    expect(await statusOf(byOwner)).toEqual({ status: "pending", revoked: false })
    const audits = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log
       WHERE action = 'org.invite_revoked'
         AND meta->>'inviteId' = ${byAdmin}
         AND meta->>'reason' = 'inviter_removed'
    `
    expect(audits[0]?.n).toBe(1)
  })

  it("revokes on an admin-to-member demotion, but not when the demotion is refused", async () => {
    const owner = await newUser("Owner")
    const admin = await newUser("Admin")
    const orgId = await newOrg(owner)
    await seat(orgId, admin, "admin")
    const byAdmin = await invite(orgId, admin)

    await expect(
      orgs.setMemberRoleTx({
        organizationId: orgId,
        userId: admin,
        role: "member",
        actorId: owner,
      }),
    ).resolves.toBe("updated")
    expect((await statusOf(byAdmin)).status).toBe("revoked")

    const orphan = await newOrg(owner)
    const lastAdmin = await newUser("Last admin")
    await seat(orphan, lastAdmin, "admin")
    const kept = await invite(orphan, lastAdmin)
    await h.sql`
      DELETE FROM organization_members WHERE organization_id = ${orphan} AND role = 'owner'
    `
    await expect(
      orgs.setMemberRoleTx({
        organizationId: orphan,
        userId: lastAdmin,
        role: "member",
        actorId: lastAdmin,
      }),
    ).resolves.toBe("last_admin")
    expect((await statusOf(kept)).status).toBe("pending")
  })
})
