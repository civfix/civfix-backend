import { afterAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { PgUserStore } from "../../src/auth/pg-stores.js"


const pg = await withPg()

async function user(h: PgHarness, name: string): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name, email) VALUES (${name}, ${`${name}@example.test`}) RETURNING id
  `
  return rows[0]!.id
}

async function organization(h: PgHarness, slug: string, ownerId: string): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO organizations (slug, name) VALUES (${slug}, ${slug}) RETURNING id
  `
  const id = rows[0]!.id
  await h.sql`
    INSERT INTO organization_members (organization_id, user_id, role, joined_at)
    VALUES (${id}, ${ownerId}, 'owner', now() - interval '10 days')
  `
  return id
}

async function addOrgMember(
  h: PgHarness,
  orgId: string,
  userId: string,
  role: string,
  daysAgo: number,
): Promise<void> {
  await h.sql`
    INSERT INTO organization_members (organization_id, user_id, role, joined_at)
    VALUES (${orgId}, ${userId}, ${role}, now() - ${`${daysAgo} days`}::interval)
  `
}

async function event(
  h: PgHarness,
  opts: { organizerId: string; organizationId?: string; status?: string; donationUrl?: string },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO cleanups (
      organizer_user_id, organization_id, type, title, geom, scheduled_at, status, donation_url
    )
    VALUES (
      ${opts.organizerId},
      ${opts.organizationId ?? null},
      'site',
      'Creek sweep',
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      ${new Date(Date.now() + 86_400_000)},
      ${opts.status ?? "upcoming"},
      ${opts.donationUrl ?? null}
    )
    RETURNING id
  `
  const id = rows[0]!.id
  await h.sql`
    INSERT INTO cleanup_members (cleanup_id, user_id, role, joined_at)
    VALUES (${id}, ${opts.organizerId}, 'organizer', now() - interval '10 days')
  `
  return id
}

async function addEventMember(
  h: PgHarness,
  cleanupId: string,
  userId: string,
  role: string,
  daysAgo: number,
): Promise<void> {
  await h.sql`
    INSERT INTO cleanup_members (cleanup_id, user_id, role, joined_at)
    VALUES (${cleanupId}, ${userId}, ${role}, now() - ${`${daysAgo} days`}::interval)
  `
}

async function statusOf(h: PgHarness, cleanupId: string): Promise<string> {
  const rows = await h.sql<{ status: string }[]>`
    SELECT status FROM cleanups WHERE id = ${cleanupId}
  `
  return rows[0]!.status
}

async function organizerOf(h: PgHarness, cleanupId: string): Promise<string | null> {
  const rows = await h.sql<{ organizer_user_id: string | null }[]>`
    SELECT organizer_user_id FROM cleanups WHERE id = ${cleanupId}
  `
  return rows[0]!.organizer_user_id
}

async function eventRoleOf(
  h: PgHarness,
  cleanupId: string,
  userId: string,
): Promise<string | null> {
  const rows = await h.sql<{ role: string }[]>`
    SELECT role FROM cleanup_members WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
  `
  return rows[0]?.role ?? null
}

async function orgRoleOf(h: PgHarness, orgId: string, userId: string): Promise<string | null> {
  const rows = await h.sql<{ role: string }[]>`
    SELECT role FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${userId}
  `
  return rows[0]?.role ?? null
}

describe.skipIf(!pg)("erasure: the host-transfer ladder", () => {
  afterAll(async () => {
    await pg?.teardown()
  })

  it("does NOT cancel a sole-owner organization's events — the promoted admin takes them over", async () => {
    const h = pg!
    const owner = await user(h, "owner-sole")
    const admin = await user(h, "admin-successor")
    const org = await organization(h, `sole-owner-${Date.now()}`, owner)
    await addOrgMember(h, org, admin, "admin", 5)
    const orgEvent = await event(h, { organizerId: owner, organizationId: org })

    await new PgUserStore(h.db).softDeleteAndAnonymize(owner)

    expect(await statusOf(h, orgEvent)).toBe("upcoming")
    expect(await organizerOf(h, orgEvent)).toBe(admin)
    expect(await eventRoleOf(h, orgEvent, admin)).toBe("organizer")
    expect(await orgRoleOf(h, org, admin)).toBe("owner")
    expect(await orgRoleOf(h, org, owner)).toBeNull()
  })

  it("falls to the SENIOR cohost when there is no organization to inherit from", async () => {
    const h = pg!
    const host = await user(h, "host-no-org")
    const junior = await user(h, "cohost-junior")
    const senior = await user(h, "cohost-senior")
    const plain = await event(h, { organizerId: host })
    await addEventMember(h, plain, junior, "cohost", 1)
    await addEventMember(h, plain, senior, "cohost", 9)

    await new PgUserStore(h.db).softDeleteAndAnonymize(host)

    expect(await statusOf(h, plain)).toBe("upcoming")
    expect(await organizerOf(h, plain)).toBe(senior)
    expect(await eventRoleOf(h, plain, senior)).toBe("organizer")
    expect(await eventRoleOf(h, plain, host)).toBe("member")
  })

  it("cancels only what nobody could take over, and leaves no stale organizer row", async () => {
    const h = pg!
    const host = await user(h, "host-alone")
    const attendee = await user(h, "attendee-plain")
    const orphan = await event(h, { organizerId: host })
    await addEventMember(h, orphan, attendee, "member", 2)

    await new PgUserStore(h.db).softDeleteAndAnonymize(host)

    expect(await statusOf(h, orphan)).toBe("cancelled")
    expect(await organizerOf(h, orphan)).toBe(host)
    expect(await eventRoleOf(h, orphan, attendee)).toBe("member")
  })

  it("soft-deletes an organization left with nobody and clears its events' org + donation link", async () => {
    const h = pg!
    const owner = await user(h, "owner-orphaning")
    const org = await organization(h, `orphaned-${Date.now()}`, owner)
    const orgEvent = await event(h, {
      organizerId: owner,
      organizationId: org,
      donationUrl: "https://example.org/give",
    })

    await new PgUserStore(h.db).softDeleteAndAnonymize(owner)

    const orgRows = await h.sql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM organizations WHERE id = ${org}
    `
    expect(orgRows[0]!.deleted_at).not.toBeNull()

    const eventRows = await h.sql<{ organization_id: string | null; donation_url: string | null }[]>`
      SELECT organization_id, donation_url FROM cleanups WHERE id = ${orgEvent}
    `
    expect(eventRows[0]!.organization_id).toBeNull()
    expect(eventRows[0]!.donation_url).toBeNull()
    expect(await statusOf(h, orgEvent)).toBe("cancelled")
  })

  it("revokes the departing user's pending team invites and scrubs the invitee address", async () => {
    const h = pg!
    const host = await user(h, "host-inviter")
    const invitee = await user(h, "invitee")
    const target = await event(h, { organizerId: host })
    await h.sql`
      INSERT INTO cleanup_team_invites
        (cleanup_id, invited_by, invited_user_id, invited_email, role, token_hash, status, expires_at)
      VALUES (
        ${target}, ${host}, ${invitee}, 'invitee@example.test', 'cohost',
        ${"hash-" + Date.now()}, 'pending', now() + interval '7 days'
      )
    `

    await new PgUserStore(h.db).softDeleteAndAnonymize(host)

    const rows = await h.sql<
      { status: string; invited_email: string | null; email_scrubbed_at: Date | null }[]
    >`SELECT status, invited_email, email_scrubbed_at FROM cleanup_team_invites WHERE cleanup_id = ${target}`
    expect(rows[0]!.status).toBe("revoked")
    expect(rows[0]!.invited_email).toBeNull()
    expect(rows[0]!.email_scrubbed_at).not.toBeNull()
  })

  it("releases the seats an OFFERED waitlist entry reserved, and only those", async () => {
    const h = pg!
    const host = await user(h, "host-waitlist")
    const waiter = await user(h, "waiter")
    const target = await event(h, { organizerId: host })
    const typeRows = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_ticket_types (cleanup_id, name, capacity, reserved_seats, sort_order)
      VALUES (${target}, 'General', 10, 5, 0)
      RETURNING id
    `
    const ticketType = typeRows[0]!.id
    await h.sql`
      INSERT INTO cleanup_waitlist (
        cleanup_id, ticket_type_id, user_id, party_size, status, offered_at, claim_expires_at
      )
      VALUES (
        ${target}, ${ticketType}, ${waiter}, 2, 'offered', now(), now() + interval '10 minutes'
      )
    `
    await h.sql`
      INSERT INTO cleanup_waitlist (cleanup_id, ticket_type_id, user_id, party_size, status, offered_at)
      VALUES (${target}, ${ticketType}, ${host}, 3, 'waiting', ${null})
    `

    await new PgUserStore(h.db).softDeleteAndAnonymize(waiter)

    const seats = await h.sql<{ reserved_seats: number }[]>`
      SELECT reserved_seats FROM cleanup_ticket_types WHERE id = ${ticketType}
    `
    expect(seats[0]!.reserved_seats).toBe(3)
    const entry = await h.sql<{ status: string }[]>`
      SELECT status FROM cleanup_waitlist WHERE user_id = ${waiter}
    `
    expect(entry[0]!.status).toBe("cancelled")
  })

  it("unlinks donations from the profile and scrubs contact ONLY on ones that never charged", async () => {
    const h = pg!
    const donor = await user(h, "donor")
    const owner = await user(h, "org-owner-donations")
    const org = await organization(h, `donee-${Date.now()}`, owner)

    const charged = await h.sql<{ id: string }[]>`
      INSERT INTO donations (
        reference, donor_key, organization_id, user_id, donor_email, donor_name, amount_minor,
        fee_bps, stripe_account_id, status, charged_at, idempotency_owner, idempotency_key
      ) VALUES (
        'DON-1', gen_random_uuid(), ${org}, ${donor}, 'donor@example.test', 'Donor', 5000,
        500, 'acct_test', 'succeeded', now(), ${`user:${donor}`}, 'k1'
      ) RETURNING id
    `
    const abandoned = await h.sql<{ id: string }[]>`
      INSERT INTO donations (
        reference, donor_key, organization_id, user_id, donor_email, donor_name, amount_minor,
        fee_bps, stripe_account_id, status, charged_at, idempotency_owner, idempotency_key
      ) VALUES (
        'DON-2', gen_random_uuid(), ${org}, ${donor}, 'donor@example.test', 'Donor', 5000,
        500, 'acct_test', 'pending', ${null}, ${`user:${donor}`}, 'k2'
      ) RETURNING id
    `

    await new PgUserStore(h.db).softDeleteAndAnonymize(donor)

    const rows = await h.sql<
      { id: string; user_id: string | null; profile_unlinked_at: Date | null; donor_email: string | null }[]
    >`SELECT id, user_id, profile_unlinked_at, donor_email FROM donations WHERE organization_id = ${org}`
    const byId = new Map(rows.map((row) => [row.id, row]))

    for (const row of rows) {
      expect(row.user_id).toBeNull()
      expect(row.profile_unlinked_at).not.toBeNull()
    }
    expect(byId.get(charged[0]!.id)?.donor_email).toBe("donor@example.test")
    expect(byId.get(abandoned[0]!.id)?.donor_email).toBeNull()
  })

  it("notifies each new organizer after the erasure commits", async () => {
    const h = pg!
    const host = await user(h, "host-notified")
    const cohost = await user(h, "cohost-notified")
    const moved = await event(h, { organizerId: host })
    await addEventMember(h, moved, cohost, "cohost", 3)
    const notified: { userId: string; link: string | undefined; vars: unknown }[] = []

    await new PgUserStore(h.db, {
      notifier: {
        createNotification: (userId, input) => {
          notified.push({ userId, link: input.link, vars: input.vars })
          return Promise.resolve({} as never)
        },
      },
    }).softDeleteAndAnonymize(host)

    expect(notified).toHaveLength(1)
    expect(notified[0]!.userId).toBe(cohost)
    expect(notified[0]!.link).toBe(`/cleanups/${moved}`)
    expect(notified[0]!.vars).toMatchObject({ title: "Creek sweep" })
  })

  it("enqueues waitlist.promote for every ticket type the erasure released seats on", async () => {
    const h = pg!
    const host = await user(h, "host-promote")
    const waiter = await user(h, "waiter-promote")
    const target = await event(h, { organizerId: host })
    const typeRows = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_ticket_types (cleanup_id, name, capacity, reserved_seats, sort_order)
      VALUES (${target}, 'General', 10, 5, 0)
      RETURNING id
    `
    const ticketType = typeRows[0]!.id
    await h.sql`
      INSERT INTO cleanup_waitlist (
        cleanup_id, ticket_type_id, user_id, party_size, status, offered_at, claim_expires_at
      )
      VALUES (
        ${target}, ${ticketType}, ${waiter}, 2, 'offered', now(), now() + interval '10 minutes'
      )
    `
    const enqueued: { name: string; data: unknown; opts: unknown }[] = []

    await new PgUserStore(h.db, {
      jobs: {
        enqueue: (name: string, data: unknown, opts?: unknown) => {
          enqueued.push({ name, data, opts })
          return Promise.resolve("job-id")
        },
        work: () => Promise.resolve(),
        schedule: () => Promise.resolve(),
      } as never,
    }).softDeleteAndAnonymize(waiter)

    expect(enqueued).toEqual([
      {
        name: "waitlist.promote",
        data: { ticketTypeId: ticketType },
        opts: { singletonKey: ticketType },
      },
    ])
  })

  it("writes one event.host_transferred audit row per event that actually moved", async () => {
    const h = pg!
    const host = await user(h, "host-audited")
    const cohost = await user(h, "cohost-audited")
    const moved = await event(h, { organizerId: host })
    const doomed = await event(h, { organizerId: host })
    await addEventMember(h, moved, cohost, "cohost", 3)

    await new PgUserStore(h.db).softDeleteAndAnonymize(host)

    const rows = await h.sql<{ target: string; meta: Record<string, unknown> }[]>`
      SELECT target, meta FROM audit_log
       WHERE actor_id = ${host} AND action = 'event.host_transferred'
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.target).toBe(`cleanup:${moved}`)
    expect(rows[0]!.meta.newOrganizerId).toBe(cohost)
    expect(await statusOf(h, doomed)).toBe("cancelled")
  })

  it("steps a tombstone down to member on other people's events and audits it with a null actor", async () => {
    const h = pg!
    const owner = await user(h, "other-host")
    const leaving = await user(h, "leaving-cohost")
    const cohosted = await event(h, { organizerId: owner })
    const staffed = await event(h, { organizerId: owner })
    await addEventMember(h, cohosted, leaving, "cohost", 2)
    await addEventMember(h, staffed, leaving, "staff", 2)

    await new PgUserStore(h.db).softDeleteAndAnonymize(leaving)

    expect(await eventRoleOf(h, cohosted, leaving)).toBe("member")
    expect(await eventRoleOf(h, staffed, leaving)).toBe("member")

    const rows = await h.sql<{ target: string; actor_id: string | null; meta: Record<string, unknown> }[]>`
      SELECT target, actor_id, meta FROM audit_log
       WHERE action = 'event.team_role_changed'
         AND meta->>'targetUserId' = ${leaving}
       ORDER BY target
    `
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.actor_id).toBeNull()
      expect(row.meta.to).toBe("member")
    }
    expect(rows.map((r) => r.meta.from).sort()).toEqual(["cohost", "staff"])
  })
})
