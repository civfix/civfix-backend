/**
 * cleanup_slots + cleanup_slot_claims: P9 signup slots. A host defines named roles/shifts on an event
 * ("Registration table", "Grill", "8-10am sweep"), each with an optional capacity, and an attendee
 * claims exactly ONE of them.
 *
 * Identity is the surrogate uuid, NOT (cleanup_id, sort_order): slots are EDITABLE — a host renames and
 * reorders them while claims already exist, and an ordinal key would silently re-point every claim at a
 * different role. sort_order is presentational only.
 *
 * cleanup_slot_claims is keyed (cleanup_id, user_id) — the same PK shape as cleanup_members. That
 * composite PK IS the "one slot per person per event" product rule, enforced by the schema rather than
 * by application code, so a concurrent double-claim is a constraint conflict and not a race. Re-claiming
 * is an ON CONFLICT DO UPDATE (a MOVE), never a second row. The composite FK (slot_id, cleanup_id) makes
 * claiming a slot that belongs to a DIFFERENT event structurally impossible (same stance as
 * chat_poll_votes' composite FK, schema/chat-polls.ts).
 *
 * Cleanups cascade; the users FK does not (accounts soft-delete everywhere, so a cascade would never
 * fire, and a claim is roster data that must survive a tombstone exactly like its cleanup_members row).
 *
 * LOCK ORDER (binding on every writer): cleanups -> cleanup_members -> cleanup_slots ->
 * cleanup_slot_claims. joinCleanupTx already takes FOR SHARE on cleanups first, so a claim transaction
 * that starts anywhere else can deadlock ABBA against it.
 *
 * CANONICAL DDL: drizzle/0063_cleanup_slots.sql, extended by drizzle/0167_cleanup_slot_windows.sql.
 * The expression unique index cleanup_slots_cleanup_title_window_uidx
 * (cleanup_id, lower(title), COALESCE(starts_at, '-infinity'), COALESCE(ends_at, 'infinity')) is
 * deliberately NOT mirrored here — functional indexes stay SQL-only in this repo.
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
    // NULL = unlimited. Lowering it below the current claim count does NOT evict anyone: the slot
    // simply refuses new claims until it drains.
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
    // The ordered read for one event's slot list (also the batched multi-event load).
    index("cleanup_slots_cleanup_idx").on(t.cleanupId, t.sortOrder, t.id),
    // Redundant-looking, but load-bearing: the FK target for cleanup_slot_claims' composite reference.
    // A FK target must be a unique constraint and the PK alone is only (id).
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
    // The one-slot-per-person-per-event rule, in the schema.
    primaryKey({ columns: [t.cleanupId, t.userId] }),
    // "This slot belongs to THIS event" — structural, not an app-layer check that a new call path can
    // forget. Canonical in 0063_cleanup_slots.sql.
    foreignKey({
      columns: [t.slotId, t.cleanupId],
      foreignColumns: [cleanupSlots.id, cleanupSlots.cleanupId],
    }).onDelete("cascade"),
    // "Who is on this slot" (the host's per-slot roster) + the capacity count the claim transaction
    // runs under the slot row lock.
    index("cleanup_slot_claims_slot_idx").on(t.slotId),
  ],
)

export type CleanupSlotRow = typeof cleanupSlots.$inferSelect
export type NewCleanupSlotRow = typeof cleanupSlots.$inferInsert
export type CleanupSlotClaimRow = typeof cleanupSlotClaims.$inferSelect
export type NewCleanupSlotClaimRow = typeof cleanupSlotClaims.$inferInsert
