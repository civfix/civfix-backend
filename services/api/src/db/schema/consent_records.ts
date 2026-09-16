import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"
import type {
  ConsentSubjectKind,
  ConsentSurfaceValue,
  LegalDocumentTypeValue,
} from "./types-legal.js"

export const consentRecords = pgTable(
  "consent_records",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    subjectKind: text("subject_kind").$type<ConsentSubjectKind>().notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    organizationId: uuid("organization_id"),
    donationId: uuid("donation_id"),
    donorKey: uuid("donor_key"),
    documentType: text("document_type").$type<LegalDocumentTypeValue>().notNull(),
    documentVersion: text("document_version").notNull(),
    documentSha256: text("document_sha256").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    surface: text("surface").$type<ConsentSurfaceValue>().notNull(),
    screenRoute: text("screen_route"),
    uiTemplateVersion: text("ui_template_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("consent_records_donation_idx").on(t.donationId).where(sql`donation_id IS NOT NULL`),
    index("consent_records_org_idx")
      .on(t.organizationId, t.acceptedAt.desc(), t.id.desc())
      .where(sql`organization_id IS NOT NULL`),
    index("consent_records_user_idx")
      .on(t.userId, t.acceptedAt.desc(), t.id.desc())
      .where(sql`user_id IS NOT NULL`),
    index("consent_records_donor_idx")
      .on(t.donorKey, t.acceptedAt.desc())
      .where(sql`donor_key IS NOT NULL`),
  ],
)

export type ConsentRecordRow = typeof consentRecords.$inferSelect
export type NewConsentRecordRow = typeof consentRecords.$inferInsert
