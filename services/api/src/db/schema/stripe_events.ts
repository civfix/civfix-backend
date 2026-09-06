import { sql } from "drizzle-orm"
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import type { StripeEventScope } from "./types-payments.js"

export const stripeEvents = pgTable(
  "stripe_events",
  {
    id: text("id").primaryKey(),
    scope: text("scope").$type<StripeEventScope>().notNull(),
    type: text("type").notNull(),
    accountId: text("account_id"),
    objectId: text("object_id"),
    livemode: boolean("livemode").notNull().default(false),
    apiVersion: text("api_version"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    retentionUntil: timestamp("retention_until", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("stripe_events_unprocessed_idx").on(t.receivedAt).where(sql`processed_at IS NULL`),
    index("stripe_events_failed_idx")
      .on(t.receivedAt.desc())
      .where(sql`processed_at IS NULL AND error IS NOT NULL`),
    index("stripe_events_account_idx")
      .on(t.accountId, t.receivedAt.desc())
      .where(sql`account_id IS NOT NULL`),
    index("stripe_events_object_idx")
      .on(t.objectId, t.receivedAt.desc())
      .where(sql`object_id IS NOT NULL`),
    index("stripe_events_retention_idx").on(t.retentionUntil),
  ],
)

export type StripeEventRow = typeof stripeEvents.$inferSelect
export type NewStripeEventRow = typeof stripeEvents.$inferInsert
