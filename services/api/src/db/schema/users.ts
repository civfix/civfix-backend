/**
 * users: an account in civfix. May be a citizen, a government user/admin, or an internal operator.
 *
 * Notes:
 *   - `role` is a plain text column (not a pg enum) per the canonical DDL; it is typed at the TS
 *     level via `$type<Role>()` so query code gets the narrow union while the DB stays flexible.
 *   - `handle` is CITEXT and uniquely indexed so "@Jane" and "@jane" cannot both exist.
 *   - `email` is CITEXT (case-insensitive) and nullable. It carries the verified account email used by
 *     OTP and OAuth find-or-create. A PARTIAL UNIQUE index (WHERE email IS NOT NULL) keeps it unique
 *     while still allowing many rows with a NULL email. `email_verified` records whether the address
 *     was proven (verified OTP or a verified-email OAuth claim).
 *   - `deleted_at` is a soft-delete tombstone; rows are not hard-deleted.
 *
 * The hand-authored SQL is the DDL source of truth: services/api/drizzle/0001_core.sql for the base
 * table and 0003_users_email.sql for the email columns + partial unique index added in this step.
 */

import { sql } from "drizzle-orm"
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { citext, type ROLE_VALUES } from "./types.js"

type Role = (typeof ROLE_VALUES)[number]

export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    role: text("role").$type<Role>().notNull().default("citizen"),
    displayName: text("display_name").notNull(),
    handle: citext("handle"),
    email: citext("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    bio: text("bio"),
    // Provider (Google) profile photo URL; NULL => clients render the solid-color + letter monogram.
    avatarUrl: text("avatar_url"),
    // First-run registration gate: false until the user sets a username + name. Backfilled true for
    // pre-existing accounts in 0006 so only NEW users are forced through registration.
    profileComplete: boolean("profile_complete").notNull().default(false),
    // Per-account DM toggle (0009). When false the user is hidden from people search and a NEW openDm
    // toward them is rejected; existing dm threads keep working. NOT NULL default true.
    allowDirectMessages: boolean("allow_direct_messages").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("users_handle_key").on(t.handle),
    index("users_role_idx").on(t.role),
    // Partial unique: emails are unique when present, but multiple NULLs are allowed.
    uniqueIndex("users_email_key")
      .on(t.email)
      .where(sql`${t.email} is not null`),
  ],
)

export type UserRow = typeof users.$inferSelect
export type NewUserRow = typeof users.$inferInsert
