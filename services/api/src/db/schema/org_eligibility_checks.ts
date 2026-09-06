import { sql } from "drizzle-orm"
import { boolean, date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import type {
  EligibilitySourceValue,
  EligibilityVerdictContribution,
} from "./types-payments.js"

export const orgEligibilityChecks = pgTable(
  "org_eligibility_checks",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id").notNull(),
    source: text("source").$type<EligibilitySourceValue>().notNull(),
    ein: text("ein"),
    irsLegalName: text("irs_legal_name"),
    foundationCode: text("foundation_code"),
    deductibilityCode: text("deductibility_code"),
    sourceRevisionDate: date("source_revision_date").notNull(),
    rawReportSha256: text("raw_report_sha256"),
    rawReportKey: text("raw_report_key"),
    matched: boolean("matched").notNull(),
    verdictContribution: text("verdict_contribution")
      .$type<EligibilityVerdictContribution>()
      .notNull(),
    detail: text("detail"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    retentionUntil: timestamp("retention_until", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("org_eligibility_checks_org_idx").on(t.organizationId, t.checkedAt.desc(), t.id.desc()),
    index("org_eligibility_checks_source_rev_idx").on(t.source, t.sourceRevisionDate),
    index("org_eligibility_checks_retention_idx").on(t.retentionUntil),
  ],
)

export type OrgEligibilityCheckRow = typeof orgEligibilityChecks.$inferSelect
export type NewOrgEligibilityCheckRow = typeof orgEligibilityChecks.$inferInsert
