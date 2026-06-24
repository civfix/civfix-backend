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
 * table, 0003_users_email.sql for the email columns + partial unique index, and 0026_user_handle_required.sql
 * for the NOT NULL handle (with a format CHECK) + the `handle_changed_at` rename-cooldown clock.
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
    // CITEXT, uniquely indexed, and NOT NULL after 0026 (every account has a @handle: real signups choose
    // one in first-run registration; pre-existing/placeholder rows are backfilled with 'user'+12 hex of id).
    handle: citext("handle").notNull(),
    // The rolling-30-day rename cooldown clock (0026). NULL => never renamed (changeable now). Stamped only
    // by a rename made AFTER profile_complete=true; the handle chosen during first-run registration does NOT.
    handleChangedAt: timestamp("handle_changed_at", { withTimezone: true }),
    email: citext("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    bio: text("bio"),
    // Provider (Google) profile photo URL; NULL => clients render the solid-color + letter monogram.
    avatarUrl: text("avatar_url"),
    // The media asset backing the user's uploaded profile picture (0019). Created via the normal
    // presign -> PUT -> finalize pipeline; PUT /me/profile resolves the finalized upload id to this row.
    // The FK -> media_assets(id) ON DELETE SET NULL lives in the canonical DDL (drizzle/0019_user_avatar.sql);
    // it is NOT mirrored as a `.references()` here because a users -> media_assets -> reports -> users
    // import cycle in the schema mirror makes drizzle's table-type inference collapse to `any`. NULL =>
    // fall back to avatar_url / the monogram.
    avatarMediaId: uuid("avatar_media_id"),
    // Per-account UI/message locale (0033). One supported language code {en,es,de,ko}; 'en' is the
    // source + fallback. SOURCE OF TRUTH for server-generated user-facing copy (push titles/bodies,
    // account/OTP emails), rendered with no client in the loop. The app-level write path validates
    // against the LocaleEnum, so the column stays a plain text (no DB CHECK), like `role`.
    locale: text("locale").notNull().default("en"),
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
    // Admin users list keyset (created_at DESC, id DESC). Added in drizzle/0013_perf_indexes.sql.
    index("users_created_id_idx").on(t.createdAt.desc(), t.id.desc()),
    // NOTE: trigram GIN indexes `users_handle_trgm ON users USING gin ((handle::text) gin_trgm_ops)`
    // and `users_display_name_trgm ON users USING gin (display_name gin_trgm_ops)` back the
    // @handle typeahead + people/admin ILIKE searches. They live in drizzle/0014_search_trgm.sql and
    // are intentionally NOT mirrored here (raw-SQL-only; handle GIN is an expression index over a
    // CITEXT cast that Drizzle cannot cleanly express).
  ],
)

export type UserRow = typeof users.$inferSelect
export type NewUserRow = typeof users.$inferInsert
