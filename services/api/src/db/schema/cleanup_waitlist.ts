import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { cleanupGuests } from "./cleanup_guests.js"
import { cleanupRegistrations } from "./cleanup_registrations.js"
import { cleanupTicketTypes } from "./cleanup_ticket_types.js"
import { users } from "./users.js"
import type { WaitlistStatusValue } from "./types-registration.js"

export const cleanupWaitlist = pgTable(
  "cleanup_waitlist",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    ticketTypeId: uuid("ticket_type_id").notNull(),
    userId: uuid("user_id").references(() => users.id),
    guestId: uuid("guest_id").references(() => cleanupGuests.id, { onDelete: "cascade" }),
    partySize: smallint("party_size").notNull().default(1),
    status: text("status").$type<WaitlistStatusValue>().notNull().default("waiting"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    offeredAt: timestamp("offered_at", { withTimezone: true }),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    promotedRegistrationId: uuid("promoted_registration_id").references(
      () => cleanupRegistrations.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    foreignKey({
      columns: [t.ticketTypeId, t.cleanupId],
      foreignColumns: [cleanupTicketTypes.id, cleanupTicketTypes.cleanupId],
    }).onDelete("cascade"),
    check(
      "cleanup_waitlist_subject_check",
      sql`(${t.userId} IS NOT NULL) <> (${t.guestId} IS NOT NULL)`,
    ),
    check(
      "cleanup_waitlist_status_check",
      sql`${t.status} IN ('waiting', 'offered', 'claimed', 'expired', 'cancelled')`,
    ),
    check("cleanup_waitlist_party_bounds", sql`${t.partySize} BETWEEN 1 AND 10`),
    check(
      "cleanup_waitlist_offer_pairing",
      sql`${t.status} <> 'offered' OR (${t.offeredAt} IS NOT NULL AND ${t.claimExpiresAt} IS NOT NULL)`,
    ),
    index("cleanup_waitlist_fifo_idx")
      .on(t.ticketTypeId, t.createdAt, t.id)
      .where(sql`status = 'waiting'`),
    index("cleanup_waitlist_expiry_idx")
      .on(t.claimExpiresAt)
      .where(sql`status = 'offered'`),
    uniqueIndex("cleanup_waitlist_active_user_uidx")
      .on(t.ticketTypeId, t.userId)
      .where(sql`status IN ('waiting', 'offered') AND user_id IS NOT NULL`),
    uniqueIndex("cleanup_waitlist_active_guest_uidx")
      .on(t.ticketTypeId, t.guestId)
      .where(sql`status IN ('waiting', 'offered') AND guest_id IS NOT NULL`),
    index("cleanup_waitlist_cleanup_idx").on(t.cleanupId, t.createdAt, t.id),
    index("cleanup_waitlist_user_idx")
      .on(t.userId, t.createdAt.desc())
      .where(sql`user_id IS NOT NULL`),
  ],
)

export type CleanupWaitlistRow = typeof cleanupWaitlist.$inferSelect
export type NewCleanupWaitlistRow = typeof cleanupWaitlist.$inferInsert
