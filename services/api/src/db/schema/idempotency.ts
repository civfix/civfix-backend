
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: uuid("key").primaryKey(),
    scope: text("scope").notNull(),
    userOrAnon: text("user_or_anon"),
    responseSnapshot: jsonb("response_snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("idempotency_keys_created_idx").on(t.createdAt)],
)

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect
export type NewIdempotencyKeyRow = typeof idempotencyKeys.$inferInsert
