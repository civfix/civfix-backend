/**
 * idempotency_keys: stored responses for idempotent mutating endpoints. The first request for a
 * (key) computes and persists `response_snapshot` (jsonb); retries with the same key replay it
 * verbatim instead of re-executing. `scope` namespaces the key per endpoint; `user_or_anon`
 * records the principal for auditing/conflict checks.
 */

import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: uuid("key").primaryKey(),
  scope: text("scope").notNull(),
  userOrAnon: text("user_or_anon"),
  responseSnapshot: jsonb("response_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
})

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect
export type NewIdempotencyKeyRow = typeof idempotencyKeys.$inferInsert
