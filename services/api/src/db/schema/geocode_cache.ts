import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import type { AddressPrecision } from "@civfix/shared"

/**
 * Mirror of drizzle/0179_address_resolution.sql. Read-through cache of reverse geocodes keyed by the
 * shared 5-decimal point key (@civfix/shared `geocodePointKey`). A row with a NULL `address` is a
 * NEGATIVE entry: the providers answered nothing, and it expires on a much shorter TTL than a hit so a
 * provider outage cannot poison the point. TTL is applied on read (services/geocode-cache.ts), never by
 * a cron.
 */
export const geocodeCache = pgTable(
  "geocode_cache",
  {
    pointKey: text("point_key").primaryKey(),
    address: text("address"),
    addressPrecision: text("address_precision").$type<AddressPrecision>(),
    cityStateLabel: text("city_state_label").notNull().default(""),
    provider: text("provider"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("geocode_cache_resolved_at_idx").on(t.resolvedAt)],
)

export type GeocodeCacheRow = typeof geocodeCache.$inferSelect
export type NewGeocodeCacheRow = typeof geocodeCache.$inferInsert
