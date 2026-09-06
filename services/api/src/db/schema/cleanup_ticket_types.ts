import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import type { TicketTypeVisibilityValue } from "./types-registration.js"

export const cleanupTicketTypes = pgTable(
  "cleanup_ticket_types",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    capacity: integer("capacity"),
    reservedSeats: integer("reserved_seats").notNull().default(0),
    salesOpensAt: timestamp("sales_opens_at", { withTimezone: true }),
    salesClosesAt: timestamp("sales_closes_at", { withTimezone: true }),
    visibility: text("visibility").$type<TicketTypeVisibilityValue>().notNull().default("public"),
    accessCodeHash: text("access_code_hash"),
    maxPartySize: smallint("max_party_size").notNull().default(1),
    sortOrder: smallint("sort_order").notNull().default(0),
    waitlistEnabled: boolean("waitlist_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "cleanup_ticket_types_visibility_check",
      sql`${t.visibility} IN ('public', 'hidden', 'access_code')`,
    ),
    check(
      "cleanup_ticket_types_capacity_positive",
      sql`${t.capacity} IS NULL OR ${t.capacity} > 0`,
    ),
    check(
      "cleanup_ticket_types_reserved_bounds",
      sql`${t.reservedSeats} >= 0 AND (${t.capacity} IS NULL OR ${t.reservedSeats} <= ${t.capacity})`,
    ),
    check(
      "cleanup_ticket_types_party_bounds",
      sql`${t.maxPartySize} BETWEEN 1 AND 10`,
    ),
    check(
      "cleanup_ticket_types_access_code_present",
      sql`${t.visibility} <> 'access_code' OR ${t.accessCodeHash} IS NOT NULL`,
    ),
    check(
      "cleanup_ticket_types_sales_window",
      sql`${t.salesOpensAt} IS NULL OR ${t.salesClosesAt} IS NULL OR ${t.salesClosesAt} > ${t.salesOpensAt}`,
    ),
    uniqueIndex("cleanup_ticket_types_id_cleanup_uidx").on(t.id, t.cleanupId),
    uniqueIndex("cleanup_ticket_types_cleanup_name_uidx").on(t.cleanupId, sql`lower(${t.name})`),
    index("cleanup_ticket_types_cleanup_idx").on(t.cleanupId, t.sortOrder, t.id),
  ],
)

export type CleanupTicketTypeRow = typeof cleanupTicketTypes.$inferSelect
export type NewCleanupTicketTypeRow = typeof cleanupTicketTypes.$inferInsert
