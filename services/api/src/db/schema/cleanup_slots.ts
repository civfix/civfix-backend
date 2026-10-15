/**
 * Signup slots: a host defines named roles or shifts on an event, each with an optional capacity, and an
 * attendee claims exactly one of them.
 *
 * Identity is the surrogate uuid, not (cleanup_id, sort_order): hosts rename and reorder slots while
 * claims exist, and an ordinal key would silently re-point every claim at a different role.
 *
 * cleanup_slot_claims is keyed (cleanup_id, user_id), so "one slot per person per event" is enforced by
 * the schema: a concurrent double-claim is a constraint conflict, not a race, and re-claiming is an
 * ON CONFLICT DO UPDATE (a move). The composite FK (slot_id, cleanup_id) makes claiming a slot of a
 * different event structurally impossible.
 *
 * The users FK does not cascade: accounts soft-delete, and a claim is roster data that must survive a
 * tombstone like its cleanup_members row.
 *
 * LOCK ORDER (binding on every writer): cleanups -> cleanup_members -> cleanup_slots ->
 * cleanup_slot_claims. joinCleanupTx takes FOR SHARE on cleanups first, so a claim transaction that
 * starts anywhere else can deadlock ABBA against it.
 *
 * The expression unique index cleanup_slots_cleanup_title_window_uidx (0167_cleanup_slot_windows.sql) is
 * SQL-only, like every functional index in this repo.
 */

import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { users } from "./users.js"

export const cleanupSlots = pgTable(
  "cleanup_slots",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    // NULL = unlimited. Lowering it below the current claim count evicts nobody: the slot just refuses
    // new claims until it drains.
    capacity: integer("capacity"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    sortOrder: smallint("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("cleanup_slots_capacity_positive", sql`${t.capacity} IS NULL OR ${t.capacity} > 0`),
    check(
      "cleanup_slots_window_chk",
      sql`(${t.startsAt} IS NULL) = (${t.endsAt} IS NULL) AND (${t.endsAt} IS NULL OR ${t.endsAt} > ${t.startsAt})`,
    ),
    index("cleanup_slots_cleanup_idx").on(t.cleanupId, t.sortOrder, t.id),
    // Redundant-looking but load-bearing: the FK target of cleanup_slot_claims' composite reference must
    // be a unique constraint, and the PK alone is only (id).
    uniqueIndex("cleanup_slots_id_cleanup_uidx").on(t.id, t.cleanupId),
  ],
)

export const cleanupSlotClaims = pgTable(
  "cleanup_slot_claims",
  {
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    slotId: uuid("slot_id")
      .notNull()
      .references(() => cleanupSlots.id, { onDelete: "cascade" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.cleanupId, t.userId] }),
    foreignKey({
      columns: [t.slotId, t.cleanupId],
      foreignColumns: [cleanupSlots.id, cleanupSlots.cleanupId],
    }).onDelete("cascade"),
    // Also serves the capacity count the claim transaction runs under the slot row lock.
    index("cleanup_slot_claims_slot_idx").on(t.slotId),
  ],
)

export type CleanupSlotRow = typeof cleanupSlots.$inferSelect
export type NewCleanupSlotRow = typeof cleanupSlots.$inferInsert
export type CleanupSlotClaimRow = typeof cleanupSlotClaims.$inferSelect
export type NewCleanupSlotClaimRow = typeof cleanupSlotClaims.$inferInsert
