import { sql } from "drizzle-orm"
import { bigint, char, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { organizations } from "./organizations.js"
import type { PayoutStatusValue } from "./types-payments.js"
import { users } from "./users.js"

export const orgPayouts = pgTable(
  "org_payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    stripeAccountId: text("stripe_account_id").notNull(),
    stripePayoutId: text("stripe_payout_id"),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    status: text("status").$type<PayoutStatusValue>().notNull().default("pending"),
    arrivalDate: timestamp("arrival_date", { withTimezone: true }),
    failureMessage: text("failure_message"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    idempotencyKey: uuid("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("org_payouts_stripe_payout_uidx")
      .on(t.stripePayoutId)
      .where(sql`stripe_payout_id IS NOT NULL`),
    uniqueIndex("org_payouts_idempotency_uidx")
      .on(t.organizationId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    index("org_payouts_org_recent_idx").on(t.organizationId, t.createdAt.desc(), t.id.desc()),
  ],
)

export type OrgPayoutRow = typeof orgPayouts.$inferSelect
export type NewOrgPayoutRow = typeof orgPayouts.$inferInsert
