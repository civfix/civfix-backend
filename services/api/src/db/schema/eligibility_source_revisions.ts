import { bigint, date, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"
import type { EligibilitySourceValue } from "./types-payments.js"

export const eligibilitySourceRevisions = pgTable(
  "eligibility_source_revisions",
  {
    source: text("source").$type<EligibilitySourceValue>().notNull(),
    sourceRevisionDate: date("source_revision_date").notNull(),
    sha256: text("sha256").notNull(),
    r2Key: text("r2_key").notNull(),
    rowCount: bigint("row_count", { mode: "number" }).notNull().default(0),
    matchedCount: bigint("matched_count", { mode: "number" }).notNull().default(0),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    retentionUntil: timestamp("retention_until", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.sourceRevisionDate] }),
    index("eligibility_source_revisions_retention_idx").on(t.retentionUntil),
  ],
)

export type EligibilitySourceRevisionRow = typeof eligibilitySourceRevisions.$inferSelect
export type NewEligibilitySourceRevisionRow = typeof eligibilitySourceRevisions.$inferInsert
