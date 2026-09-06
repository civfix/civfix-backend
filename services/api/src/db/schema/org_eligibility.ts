import { sql } from "drizzle-orm"
import { boolean, date, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"
import type { EinSourceValue, EligibilityVerdictValue } from "./types-payments.js"

export const orgEligibility = pgTable(
  "org_eligibility",
  {
    organizationId: uuid("organization_id").primaryKey(),
    verdict: text("verdict").$type<EligibilityVerdictValue>().notNull().default("unknown"),
    reasons: jsonb("reasons").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    ein: text("ein"),
    einSource: text("ein_source").$type<EinSourceValue>(),
    einSetAt: timestamp("ein_set_at", { withTimezone: true }),
    einSetBy: uuid("ein_set_by").references(() => users.id, { onDelete: "set null" }),
    irsLegalName: text("irs_legal_name"),
    irsAddress: jsonb("irs_address").$type<Record<string, string | null>>(),
    deductibilityCode: text("deductibility_code"),
    foundationCode: text("foundation_code"),
    contributionsDeductible: boolean("contributions_deductible").notNull().default(false),
    groupExemptionSubordinate: boolean("group_exemption_subordinate").notNull().default(false),
    centralOrgConfirmedAt: timestamp("central_org_confirmed_at", { withTimezone: true }),
    centralOrgConfirmedBy: uuid("central_org_confirmed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    mnosFirstSeenOn: date("mnos_first_seen_on"),
    graceExpiresAt: timestamp("grace_expires_at", { withTimezone: true }),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("org_eligibility_ein_idx").on(t.ein).where(sql`ein IS NOT NULL`),
    index("org_eligibility_verdict_idx").on(t.verdict, t.updatedAt.desc()),
    index("org_eligibility_next_check_idx").on(t.nextCheckAt).where(sql`next_check_at IS NOT NULL`),
    index("org_eligibility_grace_idx")
      .on(t.graceExpiresAt)
      .where(sql`grace_expires_at IS NOT NULL`),
  ],
)

export type OrgEligibilityRow = typeof orgEligibility.$inferSelect
export type NewOrgEligibilityRow = typeof orgEligibility.$inferInsert
