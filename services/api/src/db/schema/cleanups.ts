
import { sql } from "drizzle-orm"
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { jurisdictions } from "./jurisdictions.js"
import { users } from "./users.js"
import {
  geometry,
  type CLEANUP_STATUS_VALUES,
  type CLEANUP_TYPE_VALUES,
  type EVENT_KIND_VALUES,
} from "./types.js"

type CleanupType = (typeof CLEANUP_TYPE_VALUES)[number]
type CleanupStatus = (typeof CLEANUP_STATUS_VALUES)[number]
type EventKind = (typeof EVENT_KIND_VALUES)[number]

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
    eventKind: text("event_kind").$type<EventKind>().notNull().default("cleanup"),
    title: text("title").notNull(),
    description: text("description"),
    geom: geometry("geom", { subtype: "Point", srid: 4326 }).notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    status: text("status").$type<CleanupStatus>().notNull(),
    bring: text("bring").array(),
    address: text("address"),
    capacity: integer("capacity"),
    bags: integer("bags").notNull().default(0),
    referenceCode: text("reference_code"),
    jurisdictionGeoid: text("jurisdiction_geoid").references(() => jurisdictions.geoid),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("cleanups_scheduled_idx").on(t.scheduledAt),
    index("cleanups_status_idx").on(t.status),
    index("cleanups_organizer_idx").on(t.organizerUserId),
    index("cleanups_created_idx").on(t.createdAt.desc()),
    uniqueIndex("cleanups_reference_code_uidx").on(t.referenceCode),
    index("cleanups_jurisdiction_idx").on(t.jurisdictionGeoid),
  ],
)

export type CleanupRow = typeof cleanups.$inferSelect
export type NewCleanupRow = typeof cleanups.$inferInsert
