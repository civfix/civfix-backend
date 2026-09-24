/**
 * The enforcement record behind attendee removal. SECURITY: joining is a self-service insert, so without
 * a ban a removed user could re-join instantly. The ban is written in the same transaction as the
 * membership delete and checked by joinCleanupTx before the membership insert; it lives outside
 * cleanup_members because it must survive that row's deletion. The user FKs do not cascade, so bans
 * survive user soft-delete.
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
    // Nullable so an operator-initiated removal can leave it unset rather than fabricate an actor.
    bannedByUserId: uuid("banned_by_user_id").references(() => users.id),
    // Unused by the current remove flow: the wire has no reason field.
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
