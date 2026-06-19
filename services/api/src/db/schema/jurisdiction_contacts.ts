/**
 * jurisdiction_contacts: per-category routing contacts for a jurisdiction (Phase 2).
 *
 * Extends jurisdictions WITHOUT breaking the legacy jurisdictions.contactEmails[]. A row with a NULL
 * `category` is the default/all-categories contact; a row with a category is the override for that
 * report category. Routing resolution order: category-specific -> default (NULL category) -> legacy
 * jurisdictions.contactEmails[]. The "single typed contact per (geoid, category)" + "single default
 * per geoid" invariants are enforced by two PARTIAL UNIQUE indexes in 0007_admin_phase2.sql (a plain
 * UNIQUE(geoid, category) would not collide two NULL categories in Postgres).
 *
 * CANONICAL DDL: drizzle/0007_admin_phase2.sql. This mirror exists for typed queries / diff inspection.
 */

import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { jurisdictions } from "./jurisdictions.js"

export const jurisdictionContacts = pgTable(
  "jurisdiction_contacts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    geoid: text("geoid")
      .notNull()
      .references(() => jurisdictions.geoid),
    // NULL category = the default/all-categories contact for the jurisdiction.
    category: text("category"),
    email: text("email"),
    formUrl: text("form_url"),
    // Per-contact bounce marker (0020): set when an outbound to this address hard-bounces, so the
    // directory can surface a 'bounced' contact and re-open discovery. Nullable; NULL = no known bounce.
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("jurisdiction_contacts_geoid_category_key")
      .on(t.geoid, t.category)
      .where(sql`category IS NOT NULL`),
    uniqueIndex("jurisdiction_contacts_geoid_default_key")
      .on(t.geoid)
      .where(sql`category IS NULL`),
    index("jurisdiction_contacts_geoid_idx").on(t.geoid),
  ],
)

export type JurisdictionContactRow = typeof jurisdictionContacts.$inferSelect
export type NewJurisdictionContactRow = typeof jurisdictionContacts.$inferInsert
