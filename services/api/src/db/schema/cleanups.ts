/**
 * cleanups: a community cleanup event (a single site or a route) organized by a user.
 *
 * `geom` is a Point(4326) for the meeting point / site; the GiST index is in 0001_core.sql. `bring`
 * is a text[] checklist of items to bring. `scheduled_at` and `status` drive the upcoming/past feeds.
 * `address` is the nullable host "name the spot" display line (added in 0004_cleanup_address.sql).
 */

import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"
import { geometry, type CLEANUP_STATUS_VALUES, type CLEANUP_TYPE_VALUES } from "./types.js"

type CleanupType = (typeof CLEANUP_TYPE_VALUES)[number]
type CleanupStatus = (typeof CLEANUP_STATUS_VALUES)[number]

export const cleanups = pgTable(
  "cleanups",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizerUserId: uuid("organizer_user_id")
      .notNull()
      .references(() => users.id),
    type: text("type").$type<CleanupType>().notNull(),
    title: text("title").notNull(),
    description: text("description"),
    geom: geometry("geom", { subtype: "Point", srid: 4326 }).notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    status: text("status").$type<CleanupStatus>().notNull(),
    bring: text("bring").array(),
    // Nullable host-typed display line; see 0004_cleanup_address.sql.
    address: text("address"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  // NOTE: GiST(geom) is in 0001_core.sql.
  (t) => [
    index("cleanups_scheduled_idx").on(t.scheduledAt),
    index("cleanups_status_idx").on(t.status),
    index("cleanups_organizer_idx").on(t.organizerUserId),
  ],
)

export type CleanupRow = typeof cleanups.$inferSelect
export type NewCleanupRow = typeof cleanups.$inferInsert
