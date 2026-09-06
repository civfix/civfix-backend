
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import {
  makeDrizzleDonationRepository,
  makeDrizzleStripeEventRepository,
  type DonationRepository,
  type StripeEventRepository,
} from "../../src/services/payments/donation-repository.drizzle.js"
import { makeDrizzleOrgPaymentsRepository } from "../../src/services/payments/org-payments-repository.drizzle.js"
import { runPaymentsRetentionLanes } from "../../src/services/payments/payments-jobs.js"

let pg: PgHarness | null = null
let donations: DonationRepository
let events: StripeEventRepository
let organizationId: string
let userId: string

const NOW = new Date("2026-06-01T12:00:00.000Z")

beforeAll(async () => {
  pg = await withPg()
  if (pg === null) return
  donations = makeDrizzleDonationRepository(pg.sql)
  events = makeDrizzleStripeEventRepository(pg.sql)

  organizationId = randomUUID()
  userId = randomUUID()

  await pg.sql`
    INSERT INTO users (id, email, name, handle)
    VALUES (${userId}, ${`donor-${userId}@example.org`}, 'Donor', ${`donor${userId.slice(0, 8)}`})
    ON CONFLICT DO NOTHING`
  await pg.sql`
    INSERT INTO organizations (id, slug, name, created_by)
    VALUES (${organizationId}, ${`org-${organizationId.slice(0, 8)}`}, 'Reach Out LA', ${userId})`
  await pg.sql`
    INSERT INTO org_stripe_accounts (organization_id, stripe_account_id, charges_enabled, onboarding_state)
    VALUES (${organizationId}, ${`acct_${organizationId.slice(0, 8)}`}, true, 'ready')`
  await pg.sql`
    INSERT INTO org_donation_settings (organization_id, enabled) VALUES (${organizationId}, true)`
})

afterAll(async () => {
  await pg?.teardown()
})

function createInput(patch: Record<string, unknown> = {}) {
  const id = randomUUID()
  return {
    id,
    reference: `CFD-${id.slice(0, 8).toUpperCase()}`,
    donorKey: randomUUID(),
    organizationId,
    eventId: null,
    userId,
    donorEmail: "donor@example.org",
    donorName: "Donor",
    shareIdentityWithOrg: false,
    amountMinor: 10_000,
    feeBps: 500,
    feePlatformMinor: 500,
    stripeAccountId: `acct_${organizationId.slice(0, 8)}`,
    sessionExpiresAt: new Date(NOW.getTime() + 1800_000),
    consentTermsVersion: "2026-09-06",
    consentDisclosureVersion: "2026-09-06",
    eligibilitySnapshot: { verdict: "eligible" },
    idempotencyOwner: `user:${userId}`,
    idempotencyKey: "idem-integration-1",
    livemode: false,
    consents: [
      { documentType: "terms", documentVersion: "2026-09-06", documentSha256: "a".repeat(64) },
    ],
    consentSurface: "web_donate",
    consentScreenRoute: "/donate/org",
    consentUiTemplateVersion: "1",
    now: NOW,
    ...patch,
  } as Parameters<DonationRepository["create"]>[0]
}

describe.skipIf(!pg)("donations against real postgres", () => {
  it("replays a repeated idempotency key onto the same donation", async () => {
    const input = createInput()
    const first = await donations.create(input)
    const second = await donations.create({ ...input, id: randomUUID() })

    expect(first.kind).toBe("created")
    expect(second.kind).toBe("replayed")
    expect(second.donation.id).toBe(first.donation.id)
  })

  it("writes the consent record inside the same transaction as the donation", async () => {
    const created = await donations.create(createInput({ idempotencyKey: "idem-consent" }))
    const rows = await (pg as PgHarness).sql<{ count: string }[]>`
      SELECT count(*) AS count FROM consent_records WHERE donation_id = ${created.donation.id}`
    expect(Number(rows[0]?.count ?? 0)).toBe(1)
  })

  it("advances a pending donation exactly once, however many times fulfil runs", async () => {
    const created = await donations.create(createInput({ idempotencyKey: "idem-fulfil" }))
    const fulfil = {
      donationId: created.donation.id,
      chargeId: "ch_integration_1",
      paymentIntentId: null,
      applicationFeeId: "fee_integration_1",
      stripeFeeMinor: 320,
      netMinor: 9180,
      cardBrand: "visa",
      cardLast4: "4242",
      chargedAt: NOW,
      retentionUntil: new Date(Date.UTC(2033, 5, 1)),
      now: NOW,
    }
    expect(await donations.fulfill(fulfil)).toBe(true)
    expect(await donations.fulfill(fulfil)).toBe(false)

    const row = await donations.findById(created.donation.id)
    expect(row?.status).toBe("succeeded")
    expect(row?.feeStripeMinor).toBe(320)
  })

  it("refuses two donations on one checkout session", async () => {
    const a = await donations.create(createInput({ idempotencyKey: "idem-session-a" }))
    const b = await donations.create(createInput({ idempotencyKey: "idem-session-b" }))
    await donations.attachCheckoutSession({
      donationId: a.donation.id,
      sessionId: "cs_shared",
      paymentIntentId: "pi_shared_a",
      expiresAt: NOW,
    })
    await expect(
      donations.attachCheckoutSession({
        donationId: b.donation.id,
        sessionId: "cs_shared",
        paymentIntentId: "pi_shared_b",
        expiresAt: NOW,
      }),
    ).rejects.toMatchObject({ code: "23505" })
  })

  it("refuses to delete an organization that still owns payments records", async () => {
    await expect(
      (pg as PgHarness).sql`DELETE FROM organizations WHERE id = ${organizationId}`,
    ).rejects.toMatchObject({ code: "23503" })
  })

  it("keeps the financial row on erasure and only NULLs the profile link", async () => {
    const created = await donations.create(createInput({ idempotencyKey: "idem-erasure" }))
    const unlinked = await donations.unlinkUser(userId, NOW)
    expect(unlinked).toBeGreaterThan(0)

    const rows = await (pg as PgHarness).sql<
      { user_id: string | null; profile_unlinked_at: Date | null; donor_email: string | null; amount_minor: string }[]
    >`
      SELECT user_id, profile_unlinked_at, donor_email, amount_minor
        FROM donations WHERE id = ${created.donation.id}`
    expect(rows[0]?.user_id).toBeNull()
    expect(rows[0]?.profile_unlinked_at).not.toBeNull()
    expect(rows[0]?.donor_email).toBe("donor@example.org")
    expect(Number(rows[0]?.amount_minor)).toBe(10_000)
  })

  it("NULLs only the contact columns when the seven-year retention falls due", async () => {
    const created = await donations.create(createInput({ idempotencyKey: "idem-retention" }))
    await (pg as PgHarness).sql`
      UPDATE donations
         SET status = 'succeeded', charged_at = ${NOW}, retention_until = ${new Date(NOW.getTime() - 1000)}
       WHERE id = ${created.donation.id}`

    const swept = await donations.sweepContactRetention(NOW, 100)
    expect(swept).toBeGreaterThan(0)

    const rows = await (pg as PgHarness).sql<
      { donor_email: string | null; donor_name: string | null; donor_key: string; amount_minor: string }[]
    >`SELECT donor_email, donor_name, donor_key, amount_minor FROM donations WHERE id = ${created.donation.id}`
    expect(rows[0]?.donor_email).toBeNull()
    expect(rows[0]?.donor_name).toBeNull()
    expect(rows[0]?.donor_key).not.toBeNull()
    expect(Number(rows[0]?.amount_minor)).toBe(10_000)
  })
})

describe.skipIf(!pg)("stripe events against real postgres", () => {
  it("deduplicates by event id and answers false on the second insert", async () => {
    const input = {
      id: `evt_${randomUUID()}`,
      scope: "connect" as const,
      type: "checkout.session.completed",
      accountId: "acct_1",
      objectId: "cs_1",
      livemode: false,
      apiVersion: null,
      payload: { hello: "world" },
      retentionUntil: new Date(NOW.getTime() + 400 * 86400_000),
    }
    expect(await events.insert(input)).toBe(true)
    expect(await events.insert(input)).toBe(false)
  })

  it("admits many events of the same type for the same object", async () => {
    const base = {
      scope: "connect" as const,
      type: "account.updated",
      accountId: "acct_repeat",
      objectId: "acct_repeat",
      livemode: false,
      apiVersion: null,
      payload: {},
      retentionUntil: new Date(NOW.getTime() + 400 * 86400_000),
    }
    expect(await events.insert({ ...base, id: `evt_${randomUUID()}` })).toBe(true)
    expect(await events.insert({ ...base, id: `evt_${randomUUID()}` })).toBe(true)
  })

  it("reaps events past their retention", async () => {
    const id = `evt_${randomUUID()}`
    await events.insert({
      id,
      scope: "platform",
      type: "application_fee.created",
      accountId: null,
      objectId: "fee_1",
      livemode: false,
      apiVersion: null,
      payload: {},
      retentionUntil: new Date(NOW.getTime() - 1000),
    })
    expect(await events.deleteExpired(NOW, 100)).toBeGreaterThan(0)
    expect(await events.find(id)).toBeNull()
  })
})

describe.skipIf(!pg)("payments retention lanes", () => {
  it("runs every lane without touching a donation that is not yet due", async () => {
    const created = await donations.create(createInput({ idempotencyKey: "idem-lanes" }))
    await (pg as PgHarness).sql`
      UPDATE donations
         SET status = 'succeeded', charged_at = ${NOW}, retention_until = ${new Date(Date.UTC(2040, 0, 1))}
       WHERE id = ${created.donation.id}`

    const deleted: string[] = []
    const result = await runPaymentsRetentionLanes(
      (pg as PgHarness).sql,
      NOW,
      {
        storage: {
          delete: (key: string) => {
            deleted.push(key)
            return Promise.resolve()
          },
        } as unknown as Parameters<typeof runPaymentsRetentionLanes>[2]["storage"],
      },
    )

    expect(result.contactNulled).toBeGreaterThanOrEqual(0)
    const rows = await (pg as PgHarness).sql<{ donor_email: string | null }[]>`
      SELECT donor_email FROM donations WHERE id = ${created.donation.id}`
    expect(rows[0]?.donor_email).toBe("donor@example.org")
  })
})

describe.skipIf(!pg)("organization payments repository", () => {
  it("returns the existing row rather than duplicating a connected account", async () => {
    const repo = makeDrizzleOrgPaymentsRepository((pg as PgHarness).sql)
    const status = {
      accountId: `acct_${organizationId.slice(0, 8)}`,
      livemode: false,
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      disabledReason: null,
      currentlyDue: [],
      pastDue: [],
      pendingVerification: [],
      futureCurrentlyDue: [],
      currentDeadlineSec: null,
      capabilities: { card_payments: "active" },
    }
    const inserted = await repo.insertStripeAccount({ organizationId, status, state: "ready" })
    expect(inserted.stripeAccountId).toBe(status.accountId)
  })
})
