import { sql } from "drizzle-orm"
import { bigint, char, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { donations } from "./donations.js"
import type { AppFeeRefundState } from "./types-payments.js"

export const donationRefunds = pgTable(
  "donation_refunds",
  {
    id: text("id").primaryKey(),
    donationId: uuid("donation_id")
      .notNull()
      .references(() => donations.id, { onDelete: "restrict" }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    status: text("status").notNull(),
    reason: text("reason"),
    appFeeRefundId: text("app_fee_refund_id"),
    appFeeRefundMinor: bigint("app_fee_refund_minor", { mode: "number" }).notNull().default(0),
    appFeeRefundState: text("app_fee_refund_state")
      .$type<AppFeeRefundState>()
      .notNull()
      .default("pending"),
    appFeeRefundError: text("app_fee_refund_error"),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("donation_refunds_donation_idx").on(t.donationId, t.createdAt.desc()),
    index("donation_refunds_app_fee_pending_idx")
      .on(t.createdAt)
      .where(sql`app_fee_refund_state IN ('pending','failed')`),
  ],
)

export type DonationRefundRow = typeof donationRefunds.$inferSelect
export type NewDonationRefundRow = typeof donationRefunds.$inferInsert
