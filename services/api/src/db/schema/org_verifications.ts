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
import { organizations } from "./organizations.js"
import { users } from "./users.js"
import type { ORG_VERIFICATION_KIND_VALUES, ORG_VERIFICATION_STATUS_VALUES } from "./types-host.js"

type OrgVerificationStatus = (typeof ORG_VERIFICATION_STATUS_VALUES)[number]
type OrgVerificationKind = (typeof ORG_VERIFICATION_KIND_VALUES)[number]

export const orgVerifications = pgTable(
  "org_verifications",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status").$type<OrgVerificationStatus>().notNull(),
    kind: text("kind").$type<OrgVerificationKind>().notNull(),
    einNumber: text("ein_number"),
    einScrubbedAt: timestamp("ein_scrubbed_at", { withTimezone: true }),
    documents: jsonb("documents")
      .notNull()
      .default(sql`'[]'::jsonb`),
    note: text("note"),
    rejectionReason: text("rejection_reason"),
    submittedBy: uuid("submitted_by").references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (t) => [
    check("org_verifications_documents_array_chk", sql`jsonb_typeof(${t.documents}) = 'array'`),
    uniqueIndex("org_verifications_pending_uidx")
      .on(t.organizationId)
      .where(sql`${t.status} = 'pending'`),
    index("org_verifications_queue_idx")
      .on(t.submittedAt.desc(), t.id.desc())
      .where(sql`${t.status} = 'pending'`),
    index("org_verifications_org_idx").on(t.organizationId, t.submittedAt.desc(), t.id.desc()),
    index("org_verifications_ein_scrub_idx")
      .on(t.reviewedAt)
      .where(
        sql`${t.einNumber} is not null and ${t.einScrubbedAt} is null and ${t.reviewedAt} is not null`,
      ),
  ],
)

export type OrgVerificationRow = typeof orgVerifications.$inferSelect
export type NewOrgVerificationRow = typeof orgVerifications.$inferInsert
