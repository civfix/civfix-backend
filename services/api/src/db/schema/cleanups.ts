
import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { jurisdictions } from "./jurisdictions.js"
import { organizations } from "./organizations.js"
import { users } from "./users.js"
import {
  citext,
  geometry,
  type CLEANUP_STATUS_VALUES,
  type CLEANUP_TYPE_VALUES,
  type EVENT_KIND_VALUES,
} from "./types.js"
import type { EVENT_VISIBILITY_VALUES } from "./types-host.js"

type CleanupType = (typeof CLEANUP_TYPE_VALUES)[number]
type CleanupStatus = (typeof CLEANUP_STATUS_VALUES)[number]
type EventKind = (typeof EVENT_KIND_VALUES)[number]
type EventVisibility = (typeof EVENT_VISIBILITY_VALUES)[number]

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
    endsAt: timestamp("ends_at", { withTimezone: true }),
    timezone: text("timezone"),
    visibility: text("visibility").$type<EventVisibility>().notNull().default("public"),
    coverMediaId: uuid("cover_media_id"),
    galleryMediaIds: uuid("gallery_media_ids").array().notNull().default([]),
    donationUrl: text("donation_url"),
    pageSlug: citext("page_slug"),
    registrationOpensAt: timestamp("registration_opens_at", { withTimezone: true }),
    registrationClosesAt: timestamp("registration_closes_at", { withTimezone: true }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    reminderOffsetsMin: integer("reminder_offsets_min").array(),
    hostReplyTo: citext("host_reply_to"),
    hostReplyToVerifiedAt: timestamp("host_reply_to_verified_at", { withTimezone: true }),
  },
  (t) => [
    check("cleanups_visibility_chk", sql`${t.visibility} IN ('public', 'unlisted', 'private')`),
    check(
      "cleanups_ends_after_start_chk",
      sql`${t.endsAt} IS NULL OR ${t.endsAt} > ${t.scheduledAt}`,
    ),
    check(
      "cleanups_registration_window_chk",
      sql`${t.registrationOpensAt} IS NULL
          OR ${t.registrationClosesAt} IS NULL
          OR ${t.registrationClosesAt} > ${t.registrationOpensAt}`,
    ),
    check("cleanups_gallery_size_chk", sql`cardinality(${t.galleryMediaIds}) <= 12`),
    check(
      "cleanups_reminder_offsets_chk",
      sql`${t.reminderOffsetsMin} IS NULL
          OR (
            cardinality(${t.reminderOffsetsMin}) <= 3
            AND ${t.reminderOffsetsMin} <@ ARRAY[60, 180, 1440, 2880, 10080]
          )`,
    ),
    check(
      "cleanups_donation_url_https_chk",
      sql`${t.donationUrl} IS NULL OR ${t.donationUrl} LIKE 'https://%'`,
    ),
    index("cleanups_scheduled_idx").on(t.scheduledAt),
    index("cleanups_status_idx").on(t.status),
    index("cleanups_organizer_idx").on(t.organizerUserId),
    index("cleanups_created_idx").on(t.createdAt.desc()),
    uniqueIndex("cleanups_reference_code_uidx").on(t.referenceCode),
    index("cleanups_jurisdiction_idx").on(t.jurisdictionGeoid),
    uniqueIndex("cleanups_page_slug_uidx")
      .on(t.pageSlug)
      .where(sql`${t.pageSlug} is not null`),
    index("cleanups_organization_scheduled_idx")
      .on(t.organizationId, t.scheduledAt.desc(), t.id.desc())
      .where(sql`${t.organizationId} is not null`),
    index("cleanups_public_scheduled_idx")
      .on(t.scheduledAt, t.id)
      .where(sql`${t.visibility} = 'public'`),
    index("cleanups_cover_media_idx")
      .on(t.coverMediaId)
      .where(sql`${t.coverMediaId} is not null`),
    index("cleanups_gallery_media_gin_idx").using("gin", t.galleryMediaIds),
  ],
)

export type CleanupRow = typeof cleanups.$inferSelect
export type NewCleanupRow = typeof cleanups.$inferInsert
