import { sql } from "drizzle-orm"
import { bigint, char, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { donations } from "./donations.js"
import type { DonationDisputeStateValue } from "./types-payments.js"

export const donationDisputes = pgTable(
  "donation_disputes",
  {
    id: text("id").primaryKey(),
    donationId: uuid("donation_id")
      .notNull()
      .references(() => donations.id, { onDelete: "restrict" }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    reason: text("reason"),
    status: text("status").notNull(),
    state: text("state").$type<DonationDisputeStateValue>().notNull().default("open"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    fundsWithdrawnAt: timestamp("funds_withdrawn_at", { withTimezone: true }),
    fundsReinstatedAt: timestamp("funds_reinstated_at", { withTimezone: true }),
    evidenceDueBy: timestamp("evidence_due_by", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("donation_disputes_donation_idx").on(t.donationId, t.createdAt.desc()),
    index("donation_disputes_open_idx").on(t.evidenceDueBy).where(sql`state = 'open'`),
  ],
)

export type DonationDisputeRow = typeof donationDisputes.$inferSelect
export type NewDonationDisputeRow = typeof donationDisputes.$inferInsert
