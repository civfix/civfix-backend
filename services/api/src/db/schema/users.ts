
import { sql } from "drizzle-orm"
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { citext, geometry, type ROLE_VALUES } from "./types.js"
import type { SocialLinks } from "@civfix/shared"

type Role = (typeof ROLE_VALUES)[number]

export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    role: text("role").$type<Role>().notNull().default("citizen"),
    displayName: text("display_name").notNull(),
    handle: citext("handle").notNull(),
    handleChangedAt: timestamp("handle_changed_at", { withTimezone: true }),
    email: citext("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    bio: text("bio"),
    avatarUrl: text("avatar_url"),
    avatarMediaId: uuid("avatar_media_id"),
    locale: text("locale").notNull().default("en"),
    profileComplete: boolean("profile_complete").notNull().default(false),
    allowDirectMessages: boolean("allow_direct_messages").notNull().default(true),
    // P6 hours privacy (0061_users_show_volunteer_hours.sql). A NULLABLE TRI-STATE, deliberately NOT
    // `notNull().default(true)`:
    //   NULL  = never chosen -> the aggregate volunteerHours + byJurisdiction + the leaderboard stay
    //           visible exactly as they were before the column existed; the ITEMISED per-event ledger
    //           on someone else's profile returns [].
    //   true  = explicit opt-in  -> aggregate AND itemised rows.
    //   false = explicit opt-out -> hidden everywhere public.
    // Aggregate/leaderboard predicates MUST be `show_volunteer_hours IS NOT FALSE` — a bare truth test
    // is NULL for every account that exists today and would silently empty the leaderboard. `IS TRUE`
    // gates the itemised items[] only. Own profile always shows.
    showVolunteerHours: boolean("show_volunteer_hours"),
    socialLinks: jsonb("social_links").$type<SocialLinks | null>(),
    // Denormalized follow-graph totals (0059_users_follow_counters.sql). Maintained in the same
    // transaction as the follows_people row by addFollow/removeFollow (social-repository.drizzle.ts) —
    // there is no trigger, so a direct edge write must bump these too. Edges to/from soft-deleted users
    // are INCLUDED, matching the correlated count(*) aggregates these replaced.
    followerCount: integer("follower_count").notNull().default(0),
    followingCount: integer("following_count").notNull().default(0),
    // Materialized "most recent locatable public act" (0102, audit H18): the point + timestamp of the
    // user's latest report, organized event, or event completion. It exists ONLY so follow suggestions
    // can bound their candidate set with a KNN index scan instead of a per-user LATERAL over the whole
    // users table; it is never projected into any DTO. Writers move it FORWARD only (see
    // report-repository / cleanup-repository), and erasure nulls both columns with the rest of the
    // tombstone. The GiST + recency indexes are built out of band (docs/out-of-band-indexes.md), so
    // they are deliberately absent from the index list below.
    lastActivityGeom: geometry("last_activity_geom", { subtype: "Point", srid: 4326 }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("users_handle_key").on(t.handle),
    index("users_role_idx").on(t.role),
    uniqueIndex("users_email_key")
      .on(t.email)
      .where(sql`${t.email} is not null`),
    index("users_created_id_idx").on(t.createdAt.desc(), t.id.desc()),
    index("users_avatar_media_idx")
      .on(t.avatarMediaId)
      .where(sql`${t.avatarMediaId} is not null`),
  ],
)

export type UserRow = typeof users.$inferSelect
export type NewUserRow = typeof users.$inferInsert
