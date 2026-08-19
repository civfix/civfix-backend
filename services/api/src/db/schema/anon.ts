/**
 * anon_tokens: server records for anonymous reporting sessions. `id` is the token id (string).
 * `report_count` and `flagged` support per-token abuse throttling. `expires_at` bounds the token
 * lifetime and is indexed for cleanup sweeps.
 *
 * DEPRECATED COLUMN: `claim_code` is dead. The claim secret moved to the report row (0005) and now
 * rests only as its SHA-256 on reports.claim_code_hash (0091); 0092 NULLed every value here and no
 * code path reads it. The DROP is deferred to the release that also drops reports.claim_code.
 *
 * NOTE: per-IP and per-H3 hourly rate-limit counters do NOT live here; they live in Redis.
 */

import { boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const anonTokens = pgTable(
  "anon_tokens",
  {
    id: text("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    reportCount: integer("report_count").notNull().default(0),
    flagged: boolean("flagged").notNull().default(false),
    claimCode: text("claim_code"),
  },
  (t) => [index("anon_tokens_expires_idx").on(t.expiresAt)],
)

export type AnonTokenRow = typeof anonTokens.$inferSelect
export type NewAnonTokenRow = typeof anonTokens.$inferInsert
