/**
 * `claim_code` is dead: the claim secret rests only as its SHA-256 on reports.claim_code_hash, 0092
 * NULLed every value here and no code path reads it. The DROP is deferred to the release that also drops
 * reports.claim_code.
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
