/**
 * users: an account in civfix. May be a citizen, a government user/admin, or an internal operator.
 *
 * Notes:
 *   - `role` is a plain text column (not a pg enum) per the canonical DDL; it is typed at the TS
 *     level via `$type<Role>()` so query code gets the narrow union while the DB stays flexible.
 *   - `handle` is CITEXT and uniquely indexed so "@Jane" and "@jane" cannot both exist.
 *   - `deleted_at` is a soft-delete tombstone; rows are not hard-deleted.
 *
 * The hand-authored SQL in services/api/drizzle/0001_core.sql is the DDL source of truth.
 */

import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
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
    bio: text("bio"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("users_handle_key").on(t.handle), index("users_role_idx").on(t.role)],
)

export type UserRow = typeof users.$inferSelect
export type NewUserRow = typeof users.$inferInsert
