
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { testHandle, withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeDrizzleOrganizationRepository } from "../../src/services/host/organization-repository.drizzle.js"
import { makeDrizzleHostTeamRepository } from "../../src/services/host/host-team-repository.drizzle.js"
import { makeDrizzleHostPortfolioRepository } from "../../src/services/host/host-portfolio-repository.drizzle.js"
import { hostStandingOf, orgStandingOf } from "../../src/services/host/host-standing.js"
import type { CleanupRepository } from "../../src/services/cleanup-repository.types.js"
import type { OrganizationRepository } from "../../src/services/host/organization-repository.types.js"
import type { HostTeamRepository } from "../../src/services/host/host-team-repository.types.js"

const pg = await withPg()
const FUTURE = new Date(Date.now() + 7 * 86_400_000)
const UNIQUE_VIOLATION = "23505"
const CHECK_VIOLATION = "23514"

describe.skipIf(!pg)("host organizations + team (integration)", () => {
  let h: PgHarness
  let cleanups: CleanupRepository
  let orgs: OrganizationRepository
  let team: HostTeamRepository

  beforeAll(() => {
    h = pg as PgHarness
    cleanups = makeDrizzleCleanupRepository(h.sql)
    orgs = makeDrizzleOrganizationRepository(h.sql)
    team = makeDrizzleHostTeamRepository(h.sql)
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string, handle?: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle)
      VALUES (${name}, ${handle ?? testHandle()})
      RETURNING id
    `
    return (u as { id: string }).id
  }

  async function newOrg(ownerId: string, slug: string): Promise<string> {
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

  async function newEvent(
    organizerId: string,
    over: { visibility?: string; organizationId?: string; pageSlug?: string } = {},
  ): Promise<string> {
    const outcome = await cleanups.createCleanupTx({
      cleanupId: randomUUID(),
      organizerUserId: organizerId,
      type: "site",
      eventKind: "cleanup",
      title: "Integration sweep",
      description: null,
      lat: 34.05,
      lng: -118.25,
      scheduledAt: FUTURE,
      status: "upcoming",
      bring: null,
      address: null,
      jurisdictionGeoid: null,
      jurCode: 0,
      linkedReportIds: [],
      slots: [],
      host: {
        ...(over.visibility !== undefined
          ? { visibility: over.visibility as "public" | "unlisted" | "private" }
          : {}),
        ...(over.organizationId !== undefined ? { organizationId: over.organizationId } : {}),
        ...(over.pageSlug !== undefined ? { pageSlug: over.pageSlug } : {}),
      },
    })
    return outcome.record.id
  }

  function pgCode(err: unknown): string | undefined {
    return typeof err === "object" && err !== null
      ? ((err as { code?: string }).code ?? undefined)
      : undefined
  }

  async function expectPgError(run: () => Promise<unknown>, code: string): Promise<void> {
    let raised: unknown
    try {
      await run()
    } catch (err) {
      raised = err
    }
    expect(pgCode(raised), `expected SQLSTATE ${code}`).toBe(code)
  }

  it("applies the organization schema and enforces one owner per organization", async () => {
    const owner = await newUser("Owner")
    const other = await newUser("Other")
    const orgId = await newOrg(owner, `one-owner-${randomUUID().slice(0, 8)}`)

    await expectPgError(
      () => h.sql`
        INSERT INTO organization_members (organization_id, user_id, role)
        VALUES (${orgId}, ${other}, 'owner')
      `,
      UNIQUE_VIOLATION,
    )

    expect(await orgs.roleOf(orgId, owner)).toBe("owner")
    expect(await orgStandingOf(h.sql, orgId, owner)).toBe("owner")
    expect(await orgStandingOf(h.sql, orgId, other)).toBeNull()
  })

  it("keeps the slug unique among live rows and frees it on soft-delete", async () => {
    const a = await newUser("A")
    const b = await newUser("B")
    const slug = `slug-race-${randomUUID().slice(0, 8)}`
    const first = await newOrg(a, slug)
    expect(await orgs.createOrganizationTx({
      organizationId: randomUUID(),
      slug,
      name: "Duplicate",
      description: null,
      websiteUrl: null,
      logoMediaId: null,
      socialLinks: null,
      createdBy: b,
      now: new Date(),
    })).toBe("slug_taken")

    await h.sql`UPDATE organizations SET deleted_at = now() WHERE id = ${first}`
    const reused = await orgs.createOrganizationTx({
      organizationId: randomUUID(),
      slug,
      name: "Reused",
      description: null,
      websiteUrl: null,
      logoMediaId: null,
      socialLinks: null,
      createdBy: b,
      now: new Date(),
    })
    expect(reused).not.toBe("slug_taken")
    expect(await orgs.findOrganizationById(first, null)).toBeNull()
  })

  it("keeps at most one OPEN verification per organization and scrubs the EIN on schedule", async () => {
    const owner = await newUser("Verifier")
    const operator = await newUser("Operator")
    const orgId = await newOrg(owner, `verify-${randomUUID().slice(0, 8)}`)

    for (const note of ["first try", "second try"]) {
      await orgs.applyVerificationTx({
        verificationId: randomUUID(),
        organizationId: orgId,
        kind: "nonprofit",
        einNumber: "12-3456789",
        documentMediaIds: [],
        note,
        submittedBy: owner,
        now: new Date(),
      })
    }
    const open = await h.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM org_verifications
      WHERE organization_id = ${orgId} AND status = 'pending'
    `
    expect(open[0]?.count).toBe(1)

    const row = await orgs.adminGetVerification(orgId)
    expect(row?.einLast4).toBe("6789")
    expect(JSON.stringify(row)).not.toContain("3456789")

    expect(
      await orgs.decideVerificationTx({
        organizationId: orgId,
        decision: "verified",
        kind: "nonprofit",
        reason: null,
        reviewedBy: operator,
        now: new Date(),
      }),
    ).toBe("decided")
    const after = await orgs.findOrganizationById(orgId, owner)
    expect(after?.verifiedStatus).toBe("verified")
    expect(after?.verifiedKind).toBe("nonprofit")

    expect(await orgs.scrubDecidedEins(new Date(Date.now() - 86_400_000), 100)).toBe(0)
    expect(await orgs.scrubDecidedEins(new Date(Date.now() + 86_400_000), 100)).toBe(1)
    const scrubbed = await h.sql<{ ein_number: string | null; ein_scrubbed_at: Date | null }[]>`
      SELECT ein_number, ein_scrubbed_at FROM org_verifications WHERE organization_id = ${orgId}
    `
    expect(scrubbed[0]?.ein_number).toBeNull()
    expect(scrubbed[0]?.ein_scrubbed_at).not.toBeNull()
  })

  it("clears every donation link on the org's events when verification is revoked", async () => {
    const owner = await newUser("Donee")
    const operator = await newUser("Reviewer")
    const orgId = await newOrg(owner, `donate-${randomUUID().slice(0, 8)}`)
    const eventId = await newEvent(owner, { organizationId: orgId })
    await h.sql`
      UPDATE cleanups SET donation_url = 'https://give.example.org/x' WHERE id = ${eventId}
    `
    await orgs.applyVerificationTx({
      verificationId: randomUUID(),
      organizationId: orgId,
      kind: "nonprofit",
      einNumber: null,
      documentMediaIds: [],
      note: null,
      submittedBy: owner,
      now: new Date(),
    })
    await orgs.decideVerificationTx({
      organizationId: orgId,
      decision: "rejected",
      kind: null,
      reason: "no determination letter",
      reviewedBy: operator,
      now: new Date(),
    })
    const rows = await h.sql<{ donation_url: string | null }[]>`
      SELECT donation_url FROM cleanups WHERE id = ${eventId}
    `
    expect(rows[0]?.donation_url).toBeNull()
  })

  it("enforces the cleanups host CHECK constraints the service also enforces", async () => {
    const owner = await newUser("Checker")
    const eventId = await newEvent(owner)

    await expectPgError(
      () => h.sql`UPDATE cleanups SET visibility = 'secret' WHERE id = ${eventId}`,
      CHECK_VIOLATION,
    )
    await expectPgError(
      () => h.sql`UPDATE cleanups SET ends_at = scheduled_at WHERE id = ${eventId}`,
      CHECK_VIOLATION,
    )
    await expectPgError(
      () => h.sql`UPDATE cleanups SET reminder_offsets_min = ARRAY[7] WHERE id = ${eventId}`,
      CHECK_VIOLATION,
    )
    await expectPgError(
      () => h.sql`
        UPDATE cleanups SET reminder_offsets_min = ARRAY[60, 180, 1440, 2880] WHERE id = ${eventId}
      `,
      CHECK_VIOLATION,
    )
    await expectPgError(
      () => h.sql`UPDATE cleanups SET donation_url = 'http://give.example.org' WHERE id = ${eventId}`,
      CHECK_VIOLATION,
    )
    await expectPgError(
      () => h.sql`
        UPDATE cleanups SET registration_opens_at = ${FUTURE},
                            registration_closes_at = ${new Date(FUTURE.getTime() - 1000)}
        WHERE id = ${eventId}
      `,
      CHECK_VIOLATION,
    )
    await h.sql`
      UPDATE cleanups SET reminder_offsets_min = ARRAY[60, 1440], visibility = 'unlisted'
      WHERE id = ${eventId}
    `
  })

  it("keeps a page slug unique across events and resolves an event by it", async () => {
    const owner = await newUser("Slugger")
    const slug = `page-${randomUUID().slice(0, 8)}`
    const first = await newEvent(owner, { pageSlug: slug })
    await expect(newEvent(owner, { pageSlug: slug })).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { pageSlug: "that address is already taken" },
    })
    const found = await cleanups.findCleanupByPageSlug(slug)
    expect(found?.id).toBe(first)
  })

  it("resolves the additive org lane of hostStandingOf in one query", async () => {
    const organizer = await newUser("Organizer")
    const orgOwner = await newUser("OrgOwner")
    const stranger = await newUser("Stranger")
    const orgId = await newOrg(orgOwner, `standing-${randomUUID().slice(0, 8)}`)
    await h.sql`
      INSERT INTO organization_members (organization_id, user_id, role)
      VALUES (${orgId}, ${organizer}, 'member')
    `
    const eventId = await newEvent(organizer, { organizationId: orgId })

    const asOrganizer = await hostStandingOf(h.sql, eventId, organizer)
    expect(asOrganizer?.standing).toEqual({ eventRole: "organizer", orgRole: "member" })
    const asOrgOwner = await hostStandingOf(h.sql, eventId, orgOwner)
    expect(asOrgOwner?.standing).toEqual({ eventRole: null, orgRole: "owner" })
    const asStranger = await hostStandingOf(h.sql, eventId, stranger)
    expect(asStranger?.standing).toEqual({ eventRole: null, orgRole: null })
    expect(asStranger?.organizationId).toBe(orgId)

    const batched = await cleanups.standingsOf([eventId], orgOwner)
    expect(batched.get(eventId)).toEqual({ eventRole: null, orgRole: "owner" })
  })

  it("resolves hostStandingOf for an anonymous viewer instead of failing the Parse", async () => {
    const organizer = await newUser("AnonStandingHost")
    const eventId = await newEvent(organizer)
    const anonymous = await hostStandingOf(h.sql, eventId, null)
    expect(anonymous?.standing).toEqual({ eventRole: null, orgRole: null })
    expect(anonymous?.organizerUserId).toBe(organizer)
  })

  it("counts only public live events in the eventCount an anonymous caller sees", async () => {
    const owner = await newUser("CountOwner")
    const slug = `count-${randomUUID().slice(0, 8)}`
    const orgId = await newOrg(owner, slug)
    await newEvent(owner, { organizationId: orgId, visibility: "public" })
    await newEvent(owner, { organizationId: orgId, visibility: "private" })
    const unlisted = await newEvent(owner, { organizationId: orgId, visibility: "unlisted" })
    const cancelled = await newEvent(owner, { organizationId: orgId, visibility: "public" })
    await h.sql`UPDATE cleanups SET status = 'cancelled' WHERE id = ${cancelled}`

    const anonymous = await orgs.findOrganizationBySlug(slug, null)
    expect(anonymous?.eventCount).toBe(1)
    const asOwner = await orgs.findOrganizationBySlug(slug, owner)
    expect(asOwner?.eventCount).toBe(4)
    expect(unlisted).toBeTruthy()
  })

  it("keeps the open application's documents on a re-submission that omits them", async () => {
    const owner = await newUser("ResubmitOwner")
    const orgId = await newOrg(owner, `resubmit-${randomUUID().slice(0, 8)}`)
    const [doc] = await h.sql<{ id: string }[]>`
      INSERT INTO media_assets (upload_id, kind, status, r2_key, purpose, finalized_at)
      VALUES (gen_random_uuid(), 'image', 'ready', ${`k-${randomUUID()}`}, 'report', now())
      RETURNING id
    `
    const docId = (doc as { id: string }).id
    await orgs.applyVerificationTx({
      verificationId: randomUUID(),
      organizationId: orgId,
      kind: "nonprofit",
      einNumber: "12-3456789",
      documentMediaIds: [docId],
      note: null,
      submittedBy: owner,
      now: new Date(),
    })
    await h.sql`
      UPDATE media_assets SET created_at = now() - interval '2 days' WHERE id = ${docId}
    `

    await orgs.applyVerificationTx({
      verificationId: randomUUID(),
      organizationId: orgId,
      kind: "nonprofit",
      einNumber: "12-3456789",
      documentMediaIds: [],
      note: "corrected",
      submittedBy: owner,
      now: new Date(),
    })
    const kept = await h.sql<{ documents: { mediaId: string }[]; note: string | null }[]>`
      SELECT documents, note FROM org_verifications WHERE organization_id = ${orgId}
    `
    expect(kept).toHaveLength(1)
    expect(kept[0]!.documents).toEqual([{ mediaId: docId }])
    expect(kept[0]!.note).toBe("corrected")

    await orgs.applyVerificationTx({
      verificationId: randomUUID(),
      organizationId: orgId,
      kind: "nonprofit",
      einNumber: "12-3456789",
      documentMediaIds: [docId],
      note: "relisted",
      submittedBy: owner,
      now: new Date(),
    })
    const relisted = await h.sql<{ documents: { mediaId: string }[] }[]>`
      SELECT documents FROM org_verifications WHERE organization_id = ${orgId}
    `
    expect(relisted[0]!.documents).toEqual([{ mediaId: docId }])
  })

  it("keeps unlisted and private events out of the anonymous list feed", async () => {
    const organizer = await newUser("Feeder")
    const stranger = await newUser("Passerby")
    const publicId = await newEvent(organizer, { visibility: "public" })
    const unlistedId = await newEvent(organizer, { visibility: "unlisted" })
    const privateId = await newEvent(organizer, { visibility: "private" })

    const anon = await cleanups.listCleanups({
      when: "upcoming",
      bbox: undefined,
      near: undefined,
      cursor: null,
      limit: 50,
      viewerId: null,
    })
    const anonIds = new Set(anon.records.map((r) => r.id))
    expect(anonIds.has(publicId)).toBe(true)
    expect(anonIds.has(unlistedId)).toBe(false)
    expect(anonIds.has(privateId)).toBe(false)

    const asStranger = await cleanups.listCleanups({
      when: "upcoming",
      bbox: undefined,
      near: undefined,
      cursor: null,
      limit: 50,
      viewerId: stranger,
    })
    expect(new Set(asStranger.records.map((r) => r.id)).has(privateId)).toBe(false)

    const asHost = await cleanups.listCleanups({
      when: "upcoming",
      bbox: undefined,
      near: undefined,
      cursor: null,
      limit: 50,
      viewerId: organizer,
    })
    const hostIds = new Set(asHost.records.map((r) => r.id))
    expect(hostIds.has(unlistedId)).toBe(true)
    expect(hostIds.has(privateId)).toBe(true)
  })

  it("refuses to let a stranger JOIN their way into a private event", async () => {
    const organizer = await newUser("Owner of secrets")
    const stranger = await newUser("Passerby")
    const invited = await newUser("Invited")
    const privateId = await newEvent(organizer, { visibility: "private" })
    const unlistedId = await newEvent(organizer, { visibility: "unlisted" })

    expect(await cleanups.joinCleanupTx(privateId, stranger)).toBe("not_found")
    const members = await h.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM cleanup_members WHERE cleanup_id = ${privateId}
    `
    expect(members[0]?.count).toBe(1)

    expect(await cleanups.joinCleanupTx(unlistedId, stranger)).toBe("joined")

    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role)
      VALUES (${privateId}, ${invited}, 'member')
    `
    expect(await cleanups.joinCleanupTx(privateId, invited)).toBe("joined")
  })

  it("keeps a private event out of a public report's linkedEvents block", async () => {
    const organizer = await newUser("Linker")
    const privateId = await newEvent(organizer, { visibility: "private" })
    const publicId = await newEvent(organizer, { visibility: "public" })
    const [report] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        reporter_user_id, idempotency_key, geom, geom_source, category, status, visibility, h3_cell
      )
      VALUES (
        ${organizer}, ${randomUUID()},
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326), 'device',
        'trash', 'published', 'public', 'h3-test'
      )
      RETURNING id
    `
    const reportId = (report as { id: string }).id
    await h.sql`
      INSERT INTO cleanup_reports (cleanup_id, report_id) VALUES (${privateId}, ${reportId})
    `
    await h.sql`
      INSERT INTO cleanup_reports (cleanup_id, report_id) VALUES (${publicId}, ${reportId})
    `
    const grouped = await cleanups.loadLinkedEventsForReports([reportId])
    expect((grouped.get(reportId) ?? []).map((e) => e.id)).toEqual([publicId])
  })

  it("replays an idempotent create instead of writing a second event", async () => {
    const organizer = await newUser("Replayer")
    const key = `create-${randomUUID()}`
    const args = {
      organizerUserId: organizer,
      type: "site" as const,
      eventKind: "cleanup" as const,
      title: "Replay sweep",
      description: null,
      lat: 34.05,
      lng: -118.25,
      scheduledAt: FUTURE,
      status: "upcoming" as const,
      bring: null,
      address: null,
      jurisdictionGeoid: null,
      jurCode: 0,
      linkedReportIds: [],
      slots: [],
      host: {},
      idempotency: { key, scope: "cleanup.create", userOrAnon: `user:${organizer}` },
    }
    const first = await cleanups.createCleanupTx({ ...args, cleanupId: randomUUID() })
    const second = await cleanups.createCleanupTx({ ...args, cleanupId: randomUUID() })
    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.record.id).toBe(first.record.id)
    const count = await h.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM cleanups WHERE organizer_user_id = ${organizer}
    `
    expect(count[0]?.count).toBe(1)
  })

  it("accepts a team invite exactly once and scrubs the invited address", async () => {
    const organizer = await newUser("Host")
    const invitee = await newUser("Invitee")
    const eventId = await newEvent(organizer)
    const tokenHash = `hash-${randomUUID()}`

    const created = await team.createInviteTx({
      inviteId: randomUUID(),
      cleanupId: eventId,
      invitedUserId: invitee,
      invitedEmail: "invitee@example.org",
      role: "staff",
      tokenHash,
      invitedBy: organizer,
      expiresAt: new Date(Date.now() + 86_400_000),
      now: new Date(),
    })
    expect(created.kind).toBe("created")

    const duplicate = await team.createInviteTx({
      inviteId: randomUUID(),
      cleanupId: eventId,
      invitedUserId: invitee,
      invitedEmail: "invitee@example.org",
      role: "cohost",
      tokenHash: `hash-${randomUUID()}`,
      invitedBy: organizer,
      expiresAt: new Date(Date.now() + 86_400_000),
      now: new Date(),
    })
    expect(duplicate.kind).toBe("already_invited")

    const accepted = await team.acceptInviteTx({
      cleanupId: eventId,
      tokenHash,
      userId: invitee,
      now: new Date(),
    })
    expect(accepted).toEqual({ kind: "accepted", role: "staff" })

    const replay = await team.acceptInviteTx({
      cleanupId: eventId,
      tokenHash,
      userId: invitee,
      now: new Date(),
    })
    expect(replay.kind).toBe("invalid")

    const rows = await h.sql<{ invited_email: string | null; status: string }[]>`
      SELECT invited_email, status FROM cleanup_team_invites WHERE token_hash = ${tokenHash}
    `
    expect(rows[0]).toMatchObject({ invited_email: null, status: "accepted" })
    expect(await cleanups.roleOf(eventId, invitee)).toBe("staff")

    const listed = await team.listTeam(eventId, 50)
    expect(listed.map((m) => m.role).sort()).toEqual(["organizer", "staff"])

    expect(await team.expireStaleInvites(new Date(Date.now() + 30 * 86_400_000), 100)).toBe(0)
  })

  it("never demotes the organizer when they accept an invite for a lesser role", async () => {
    const host = await newUser("Boss")
    const eventId = await newEvent(host)
    const promoted = await newUser("Deputy")
    const tokenHash = `hash-${randomUUID()}`
    await team.createInviteTx({
      inviteId: randomUUID(),
      cleanupId: eventId,
      invitedUserId: promoted,
      invitedEmail: null,
      role: "staff",
      tokenHash,
      invitedBy: host,
      expiresAt: new Date(Date.now() + 86_400_000),
      now: new Date(),
    })
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role)
      VALUES (${eventId}, ${promoted}, 'organizer')
      ON CONFLICT (cleanup_id, user_id) DO UPDATE SET role = 'organizer'
    `
    const accepted = await team.acceptInviteTx({
      cleanupId: eventId,
      tokenHash,
      userId: promoted,
      now: new Date(),
    })
    expect(accepted).toEqual({ kind: "accepted", role: "organizer" })
  })

  it("lists an org officer's portfolio without an event-team row", async () => {
    const organizer = await newUser("Runner")
    const orgOwner = await newUser("Chair")
    const orgId = await newOrg(orgOwner, `portfolio-${randomUUID().slice(0, 8)}`)
    const eventId = await newEvent(organizer, { organizationId: orgId })
    const portfolio = makeDrizzleHostPortfolioRepository(h.sql)

    const mine = await portfolio.listHostedEvents({
      userId: orgOwner,
      when: "upcoming",
      organizationId: null,
      cursor: null,
      limit: 20,
    })
    const row = mine.items.find((r) => r.id === eventId)
    expect(row).toBeDefined()
    expect(row?.eventRole).toBeNull()
    expect(row?.orgRole).toBe("owner")
    expect(row?.orgId).toBe(orgId)

    const kpis = await portfolio.kpisFor(orgOwner, new Date())
    expect(kpis.eventsHosted).toBeGreaterThanOrEqual(1)
    expect(kpis.upcomingEvents).toBeGreaterThanOrEqual(1)
  })

  it("carries the widened media purposes and keeps the superset CHECK", async () => {
    for (const purpose of ["event_cover", "event_gallery", "org_logo"]) {
      const [row] = await h.sql<{ id: string }[]>`
        INSERT INTO media_assets (upload_id, kind, r2_key, status, purpose)
        VALUES (${randomUUID()}, 'image', ${`k/${randomUUID()}`}, 'ready', ${purpose})
        RETURNING id
      `
      expect(row?.id).toBeDefined()
    }
    await expectPgError(
      () => h.sql`
        INSERT INTO media_assets (upload_id, kind, r2_key, status, purpose)
        VALUES (${randomUUID()}, 'image', ${`k/${randomUUID()}`}, 'ready', 'nonsense')
      `,
      CHECK_VIOLATION,
    )
  })
})
