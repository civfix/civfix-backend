import { sql } from "drizzle-orm"
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: uuid("key").notNull(),
    scope: text("scope").notNull(),
    userOrAnon: text("user_or_anon"),
    responseSnapshot: jsonb("response_snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idempotency_keys_created_idx").on(t.createdAt),
    uniqueIndex("idempotency_key_scope_owner_uk").on(
      t.key,
      t.scope,
      sql`COALESCE(${t.userOrAnon}, '')`,
    ),
  ],
)

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect
export type NewIdempotencyKeyRow = typeof idempotencyKeys.$inferInsert
