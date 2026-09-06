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
import { cleanupTicketTypes } from "./cleanup_ticket_types.js"
import { users } from "./users.js"
import type {
  CheckinMethodValue,
  RegistrationSourceValue,
  RegistrationStatusValue,
  SeatStatusValue,
} from "./types-registration.js"

export const cleanupRegistrations = pgTable(
  "cleanup_registrations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    ticketTypeId: uuid("ticket_type_id"),
    userId: uuid("user_id").references(() => users.id),
    guestId: uuid("guest_id").references(() => cleanupGuests.id, { onDelete: "cascade" }),
    partySize: smallint("party_size").notNull().default(1),
    status: text("status").$type<RegistrationStatusValue>().notNull().default("registered"),
    source: text("source").$type<RegistrationSourceValue>().notNull().default("self"),
    hostNote: text("host_note"),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => users.id),
  },
  (t) => [
    foreignKey({
      columns: [t.ticketTypeId, t.cleanupId],
      foreignColumns: [cleanupTicketTypes.id, cleanupTicketTypes.cleanupId],
    }).onDelete("cascade"),
    check(
      "cleanup_registrations_subject_check",
      sql`(${t.userId} IS NOT NULL) <> (${t.guestId} IS NOT NULL)`,
    ),
    check(
      "cleanup_registrations_status_check",
      sql`${t.status} IN ('registered', 'cancelled', 'transferred')`,
    ),
    check(
      "cleanup_registrations_source_check",
      sql`${t.source} IN ('self', 'waitlist', 'walkup', 'transfer')`,
    ),
    check("cleanup_registrations_party_bounds", sql`${t.partySize} BETWEEN 1 AND 10`),
    check(
      "cleanup_registrations_cancelled_stamp",
      sql`${t.status} <> 'cancelled' OR ${t.cancelledAt} IS NOT NULL`,
    ),
    uniqueIndex("cleanup_registrations_active_user_uidx")
      .on(t.cleanupId, t.userId)
      .where(sql`status = 'registered' AND user_id IS NOT NULL`),
    uniqueIndex("cleanup_registrations_active_guest_uidx")
      .on(t.cleanupId, t.guestId)
      .where(sql`status = 'registered' AND guest_id IS NOT NULL`),
    uniqueIndex("cleanup_registrations_id_cleanup_uidx").on(t.id, t.cleanupId),
    index("cleanup_registrations_roster_idx").on(
      t.cleanupId,
      t.registeredAt.desc(),
      t.id.desc(),
    ),
    index("cleanup_registrations_type_idx")
      .on(t.ticketTypeId)
      .where(sql`status = 'registered'`),
    index("cleanup_registrations_user_idx")
      .on(t.userId, t.registeredAt.desc())
      .where(sql`user_id IS NOT NULL`),
    index("cleanup_registrations_guest_idx").on(t.guestId).where(sql`guest_id IS NOT NULL`),
    index("cleanup_registrations_host_note_idx")
      .on(t.cleanupId)
      .where(sql`host_note IS NOT NULL`),
  ],
)

export const cleanupRegistrationSeats = pgTable(
  "cleanup_registration_seats",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    registrationId: uuid("registration_id")
      .notNull()
      .references(() => cleanupRegistrations.id, { onDelete: "cascade" }),
    seatIndex: smallint("seat_index").notNull(),
    attendeeName: text("attendee_name"),
    ticketTokenHash: text("ticket_token_hash").notNull(),
    status: text("status").$type<SeatStatusValue>().notNull().default("active"),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    checkedInBy: uuid("checked_in_by").references(() => users.id),
    checkinMethod: text("checkin_method").$type<CheckinMethodValue>(),
    checkinCoarsenedAt: timestamp("checkin_coarsened_at", { withTimezone: true }),
    noShowAt: timestamp("no_show_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.registrationId, t.cleanupId],
      foreignColumns: [cleanupRegistrations.id, cleanupRegistrations.cleanupId],
    }).onDelete("cascade"),
    check(
      "cleanup_registration_seats_status_check",
      sql`${t.status} IN ('active', 'cancelled')`,
    ),
    check(
      "cleanup_registration_seats_method_check",
      sql`${t.checkinMethod} IS NULL OR ${t.checkinMethod} IN ('scan', 'manual', 'self', 'walkup')`,
    ),
    check(
      "cleanup_registration_seats_method_pairing",
      sql`(${t.checkedInAt} IS NULL) = (${t.checkinMethod} IS NULL)`,
    ),
    check(
      "cleanup_registration_seats_presence_exclusive",
      sql`${t.checkedInAt} IS NULL OR ${t.noShowAt} IS NULL`,
    ),
    check(
      "cleanup_registration_seats_index_bounds",
      sql`${t.seatIndex} >= 0 AND ${t.seatIndex} < 10`,
    ),
    uniqueIndex("cleanup_registration_seats_token_uidx").on(t.ticketTokenHash),
    uniqueIndex("cleanup_registration_seats_registration_seat_uidx").on(
      t.registrationId,
      t.seatIndex,
    ),
    index("cleanup_registration_seats_registration_idx").on(t.registrationId),
    index("cleanup_registration_seats_arrivals_idx")
      .on(t.cleanupId, t.checkedInAt)
      .where(sql`checked_in_at IS NOT NULL`),
    index("cleanup_registration_seats_pending_idx")
      .on(t.cleanupId)
      .where(sql`status = 'active' AND checked_in_at IS NULL AND no_show_at IS NULL`),
    index("cleanup_registration_seats_name_idx")
      .on(t.cleanupId)
      .where(sql`attendee_name IS NOT NULL`),
    index("cleanup_registration_seats_coarsen_idx")
      .on(t.cleanupId)
      .where(sql`checked_in_at IS NOT NULL AND checkin_coarsened_at IS NULL`),
  ],
)

export type CleanupRegistrationRow = typeof cleanupRegistrations.$inferSelect
export type NewCleanupRegistrationRow = typeof cleanupRegistrations.$inferInsert
export type CleanupRegistrationSeatRow = typeof cleanupRegistrationSeats.$inferSelect
export type NewCleanupRegistrationSeatRow = typeof cleanupRegistrationSeats.$inferInsert
