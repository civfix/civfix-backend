/**
 * sessions: server-side session records keyed by the SHA-256 hex of the 256-bit session token.
 *
 * The raw token is never stored: `id` is its SHA-256 hex digest, so a database leak does not expose
 * live session tokens. `ip` uses the PostGIS-independent pg `inet` type. `last_seen_at` is bumped on
 * activity for idle-timeout/analytics.
 */

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { inet } from "drizzle-orm/pg-core"
import { index } from "drizzle-orm/pg-core"
import { users } from "./users.js"

export const sessions = pgTable(
  "sessions",
  {
    // SHA-256 hex digest of the raw 256-bit token (64 lowercase hex chars).
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    ip: inet("ip"),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
)

export type SessionRow = typeof sessions.$inferSelect
export type NewSessionRow = typeof sessions.$inferInsert
