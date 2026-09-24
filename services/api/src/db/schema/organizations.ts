import { sql } from "drizzle-orm"
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { users } from "./users.js"
import { citext } from "./types.js"
import type { ORG_VERIFICATION_KIND_VALUES, ORG_VERIFICATION_STATUS_VALUES } from "./types-host.js"

type OrgVerificationStatus = (typeof ORG_VERIFICATION_STATUS_VALUES)[number]
type OrgVerificationKind = (typeof ORG_VERIFICATION_KIND_VALUES)[number]

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    slug: citext("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    websiteUrl: text("website_url"),
    donationUrl: text("donation_url"),
    logoMediaId: uuid("logo_media_id"),
    socialLinks: jsonb("social_links"),
    verifiedStatus: text("verified_status")
      .$type<OrgVerificationStatus>()
      .notNull()
      .default("unverified"),
    verifiedKind: text("verified_kind").$type<OrgVerificationKind>(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    // Reversible, and independent of verified_status and deleted_at.
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspendedReason: text("suspended_reason"),
    suspendedBy: uuid("suspended_by").references(() => users.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "organizations_website_https_chk",
      sql`${t.websiteUrl} IS NULL OR ${t.websiteUrl} LIKE 'https://%'`,
    ),
    check(
      "organizations_donation_url_https_chk",
      sql`${t.donationUrl} IS NULL OR ${t.donationUrl} LIKE 'https://%'`,
    ),
    uniqueIndex("organizations_slug_uidx")
      .on(t.slug)
      .where(sql`${t.deletedAt} is null`),
    index("organizations_verification_queue_idx")
      .on(t.verifiedStatus, t.createdAt.desc(), t.id.desc())
      .where(sql`${t.deletedAt} is null`),
    index("organizations_created_by_idx")
      .on(t.createdBy)
      .where(sql`${t.deletedAt} is null`),
    index("organizations_suspended_idx")
      .on(t.suspendedAt.desc(), t.id.desc())
      .where(sql`${t.suspendedAt} is not null and ${t.deletedAt} is null`),
    index("organizations_logo_media_idx")
      .on(t.logoMediaId)
      .where(sql`${t.logoMediaId} is not null`),
  ],
)

export type OrganizationRow = typeof organizations.$inferSelect
export type NewOrganizationRow = typeof organizations.$inferInsert
