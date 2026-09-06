import { sql } from "drizzle-orm"
import { bigint, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import type { ReconciliationStatus } from "./types-payments.js"

export const donationReconciliationRuns = pgTable(
  "donation_reconciliation_runs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    donationsChecked: integer("donations_checked").notNull().default(0),
    balanceTransactions: integer("balance_transactions").notNull().default(0),
    applicationFees: integer("application_fees").notNull().default(0),
    divergences: integer("divergences").notNull().default(0),
    divergenceDetail: jsonb("divergence_detail")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    grossMinor: bigint("gross_minor", { mode: "number" }).notNull().default(0),
    platformFeeMinor: bigint("platform_fee_minor", { mode: "number" }).notNull().default(0),
    status: text("status").$type<ReconciliationStatus>().notNull().default("ok"),
    error: text("error"),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("donation_reconciliation_runs_org_idx").on(t.organizationId, t.ranAt.desc(), t.id.desc()),
    index("donation_reconciliation_runs_diverged_idx")
      .on(t.ranAt.desc())
      .where(sql`divergences > 0`),
  ],
)

export type DonationReconciliationRunRow = typeof donationReconciliationRuns.$inferSelect
export type NewDonationReconciliationRunRow = typeof donationReconciliationRuns.$inferInsert
