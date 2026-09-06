import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { cleanupGuests } from "./cleanup_guests.js"
import { cleanups } from "./cleanups.js"
import { users } from "./users.js"
import type { UnsubscribeReasonValue, UnsubscribeScopeValue } from "./types-broadcast.js"

export const broadcastUnsubscribes = pgTable(
  "broadcast_unsubscribes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    scope: text("scope").$type<UnsubscribeScopeValue>().notNull(),
    cleanupId: uuid("cleanup_id").references(() => cleanups.id, { onDelete: "cascade" }),
    subjectKind: text("subject_kind").$type<"user" | "guest">().notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id").references(() => cleanupGuests.id, { onDelete: "cascade" }),
    reason: text("reason").$type<UnsubscribeReasonValue>().notNull().default("one_click"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("broadcast_unsubscribes_event_user_uidx")
      .on(t.cleanupId, t.userId)
      .where(sql`scope = 'event' AND subject_kind = 'user'`),
    uniqueIndex("broadcast_unsubscribes_event_guest_uidx")
      .on(t.cleanupId, t.guestId)
      .where(sql`scope = 'event' AND subject_kind = 'guest'`),
    uniqueIndex("broadcast_unsubscribes_global_user_uidx")
      .on(t.userId)
      .where(sql`scope = 'global' AND subject_kind = 'user'`),
    uniqueIndex("broadcast_unsubscribes_global_guest_uidx")
      .on(t.guestId)
      .where(sql`scope = 'global' AND subject_kind = 'guest'`),
    index("broadcast_unsubscribes_cleanup_created_idx").on(t.cleanupId, t.createdAt),
  ],
)

export type BroadcastUnsubscribeRow = typeof broadcastUnsubscribes.$inferSelect
export type NewBroadcastUnsubscribeRow = typeof broadcastUnsubscribes.$inferInsert
