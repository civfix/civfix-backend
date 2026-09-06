import { sql } from "drizzle-orm"
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"
import type { AgreementChangeKind } from "./types-payments.js"

export const orgDonationAgreementChanges = pgTable(
  "org_donation_agreement_changes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id").notNull(),
    fromVersion: text("from_version"),
    toVersion: text("to_version").notNull(),
    documentSha256: text("document_sha256").notNull(),
    changeKind: text("change_kind").$type<AgreementChangeKind>().notNull(),
    feeBpsBefore: integer("fee_bps_before"),
    feeBpsAfter: integer("fee_bps_after"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("org_donation_agreement_changes_org_idx").on(
      t.organizationId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  ],
)

export type OrgDonationAgreementChangeRow = typeof orgDonationAgreementChanges.$inferSelect
export type NewOrgDonationAgreementChangeRow = typeof orgDonationAgreementChanges.$inferInsert
