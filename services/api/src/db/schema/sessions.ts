import { index, inet, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"

export const sessions = pgTable(
  "sessions",
  {
    // SHA-256 hex of the raw token, never the token itself, so a database leak exposes no live session.
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The absolute 90-day session ceiling is measured from this column, so NULL is unrepresentable by
    // schema rather than merely unexpected. Inserts let the DB default stamp it.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    ip: inet("ip"),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
)

export type SessionRow = typeof sessions.$inferSelect
export type NewSessionRow = typeof sessions.$inferInsert
