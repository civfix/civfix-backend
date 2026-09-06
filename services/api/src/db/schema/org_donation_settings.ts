import { sql } from "drizzle-orm"
import { bigint, boolean, char, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"
import type { DonationsDisabledReason } from "./types-payments.js"

export const orgDonationSettings = pgTable(
  "org_donation_settings",
  {
    organizationId: uuid("organization_id").primaryKey(),
    enabled: boolean("enabled").notNull().default(false),
    disabledReason: text("disabled_reason").$type<DonationsDisabledReason>(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledBy: uuid("disabled_by").references(() => users.id, { onDelete: "set null" }),
    disabledReasonText: text("disabled_reason_text"),
    donorSharingDefault: boolean("donor_sharing_default").notNull().default(false),
    missionBlurb: text("mission_blurb"),
    designationNote: text("designation_note"),
    refundPolicyText: text("refund_policy_text"),
    agreedFeeBps: integer("agreed_fee_bps").notNull().default(500),
    consentAgreementVersion: text("consent_agreement_version"),
    consentAcceptedAt: timestamp("consent_accepted_at", { withTimezone: true }),
    consentAcceptedBy: uuid("consent_accepted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    minAmountMinor: bigint("min_amount_minor", { mode: "number" }).notNull().default(500),
    maxAmountMinor: bigint("max_amount_minor", { mode: "number" }).notNull().default(1000000),
    suggestedAmountsMinor: bigint("suggested_amounts_minor", { mode: "number" })
      .array()
      .notNull()
      .default(sql`'{}'`),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("org_donation_settings_enabled_idx").on(t.organizationId).where(sql`enabled`)],
)

export type OrgDonationSettingsRow = typeof orgDonationSettings.$inferSelect
export type NewOrgDonationSettingsRow = typeof orgDonationSettings.$inferInsert
