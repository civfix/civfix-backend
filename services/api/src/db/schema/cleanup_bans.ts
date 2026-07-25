/**
 * cleanup_bans: one row per (event, removed user) — the enforcement record behind attendee removal.
 *
 * SECURITY (audit 2026-07-24, M17): removing an attendee used to be a bare DELETE of the
 * cleanup_members row while joining was an unconditional self-service INSERT, so a removed user
 * re-joined instantly and in a loop. The ban row is written in the SAME transaction as the membership
 * delete and is checked by joinCleanupTx before the membership insert. It deliberately lives OUTSIDE
 * cleanup_members because it has to survive that row's deletion.
 *
 * Composite PK(cleanup_id, user_id) — one ban per person per event; deleting the cleanup cascades, the
 * user FKs do not (bans survive user soft-delete, same convention as cleanup_members). Canonical DDL:
 * drizzle/0052_cleanup_bans.sql.
 */

import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { users } from "./users.js"

export const cleanupBans = pgTable(
  "cleanup_bans",
  {
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // The host who removed them. Nullable so a future operator-initiated removal can leave it unset
    // rather than fabricate an actor.
    bannedByUserId: uuid("banned_by_user_id").references(() => users.id),
    // Free-text host note; unused by the current remove flow (no reason field on the wire).
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.cleanupId, t.userId] }),
    index("cleanup_bans_user_idx").on(t.userId),
  ],
)

export type CleanupBanRow = typeof cleanupBans.$inferSelect
export type NewCleanupBanRow = typeof cleanupBans.$inferInsert
