
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
    showVolunteerHours: boolean("show_volunteer_hours"),
    socialLinks: jsonb("social_links").$type<SocialLinks | null>(),
    followerCount: integer("follower_count").notNull().default(0),
    followingCount: integer("following_count").notNull().default(0),
    lastActivityGeom: geometry("last_activity_geom", { subtype: "Point", srid: 4326 }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    primaryOrganizationId: uuid("primary_organization_id"),
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
