import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { users } from "./users.js"
import { citext } from "./types.js"
import type { DonationDisputeStateValue, DonationStatusValue } from "./types-payments.js"

export const donations = pgTable(
  "donations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    reference: text("reference").notNull(),
    donorKey: uuid("donor_key").notNull(),
    organizationId: uuid("organization_id").notNull(),
    eventId: uuid("event_id").references(() => cleanups.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    profileUnlinkedAt: timestamp("profile_unlinked_at", { withTimezone: true }),
    donorEmail: citext("donor_email"),
    donorName: text("donor_name"),
    shareIdentityWithOrg: boolean("share_identity_with_org").notNull().default(false),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    feeBps: integer("fee_bps").notNull(),
    feePlatformMinor: bigint("fee_platform_minor", { mode: "number" }).notNull().default(0),
    feeStripeMinor: bigint("fee_stripe_minor", { mode: "number" }),
    netMinor: bigint("net_minor", { mode: "number" }),
    status: text("status").$type<DonationStatusValue>().notNull().default("pending"),
    failureReason: text("failure_reason"),
    disputeState: text("dispute_state")
      .$type<DonationDisputeStateValue>()
      .notNull()
      .default("none"),
    refundedTotalMinor: bigint("refunded_total_minor", { mode: "number" }).notNull().default(0),
    feeRefundedMinor: bigint("fee_refunded_minor", { mode: "number" }).notNull().default(0),
    stripeAccountId: text("stripe_account_id").notNull(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeChargeId: text("stripe_charge_id"),
    stripeApplicationFeeId: text("stripe_application_fee_id"),
    cardBrand: text("card_brand"),
    cardLast4: text("card_last4"),
    livemode: boolean("livemode").notNull().default(false),
    chargedAt: timestamp("charged_at", { withTimezone: true }),
    sessionExpiresAt: timestamp("session_expires_at", { withTimezone: true }),
    receiptAttemptAt: timestamp("receipt_attempt_at", { withTimezone: true }),
    receiptSentAt: timestamp("receipt_sent_at", { withTimezone: true }),
    receiptKey: text("receipt_key"),
    receiptDocumentVersion: text("receipt_document_version"),
    consentTermsVersion: text("consent_terms_version"),
    consentDisclosureVersion: text("consent_disclosure_version"),
    consentRecordId: uuid("consent_record_id"),
    eligibilitySnapshot: jsonb("eligibility_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    idempotencyOwner: text("idempotency_owner").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("donations_reference_uidx").on(t.reference),
    uniqueIndex("donations_idempotency_uidx").on(t.idempotencyOwner, t.idempotencyKey),
    uniqueIndex("donations_checkout_session_uidx")
      .on(t.stripeCheckoutSessionId)
      .where(sql`stripe_checkout_session_id IS NOT NULL`),
    uniqueIndex("donations_payment_intent_uidx")
      .on(t.stripePaymentIntentId)
      .where(sql`stripe_payment_intent_id IS NOT NULL`),
    index("donations_charge_idx").on(t.stripeChargeId).where(sql`stripe_charge_id IS NOT NULL`),
    index("donations_org_charged_idx").on(t.organizationId, t.chargedAt.desc(), t.id.desc()),
    index("donations_org_created_idx").on(t.organizationId, t.createdAt.desc(), t.id.desc()),
    index("donations_user_charged_idx")
      .on(t.userId, t.chargedAt.desc(), t.id.desc())
      .where(sql`user_id IS NOT NULL`),
    index("donations_user_created_idx")
      .on(t.userId, t.createdAt.desc(), t.id.desc())
      .where(sql`user_id IS NOT NULL`),
    index("donations_pending_expiry_idx")
      .on(t.sessionExpiresAt)
      .where(sql`status = 'pending'`),
    index("donations_receipt_due_idx")
      .on(t.chargedAt)
      .where(sql`status IN ('succeeded','partially_refunded') AND receipt_sent_at IS NULL`),
    index("donations_retention_idx")
      .on(t.retentionUntil)
      .where(sql`retention_until IS NOT NULL AND donor_email IS NOT NULL`),
    index("donations_event_idx").on(t.eventId).where(sql`event_id IS NOT NULL`),
  ],
)

export type DonationRow = typeof donations.$inferSelect
export type NewDonationRow = typeof donations.$inferInsert
