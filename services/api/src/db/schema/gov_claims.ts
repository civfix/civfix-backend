/**
 * Government provisioning queue: approving a claim sets the linked user's role to gov_admin and links the
 * jurisdiction, so every transition is audited via writeAudit.
 *
 * `checks` jsonb shape: { linkedin|directory|callback: { status:'verified'|'pending',
 * evidence?:string, note?:string, at?:timestamp } }.
 */

import { sql } from "drizzle-orm"
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { jurisdictions } from "./jurisdictions.js"
import { users } from "./users.js"
import type { GOV_CLAIM_STATUS_VALUES, GOV_METHOD_VALUES } from "./types.js"

type GovMethod = (typeof GOV_METHOD_VALUES)[number]
type GovClaimStatus = (typeof GOV_CLAIM_STATUS_VALUES)[number]

export const govClaims = pgTable(
  "gov_claims",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id").references(() => users.id),
    name: text("name").notNull(),
    title: text("title"),
    org: text("org"),
    jurisdictionGeoid: text("jurisdiction_geoid").references(() => jurisdictions.geoid),
    method: text("method").$type<GovMethod>().notNull(),
    contactEmail: text("contact_email"),
    status: text("status").$type<GovClaimStatus>().notNull().default("pending"),
    checks: jsonb("checks").notNull().default({}),
    rejectReason: text("reject_reason"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("gov_claims_status_created_idx").on(t.status, t.createdAt.desc()),
    index("gov_claims_geoid_idx").on(t.jurisdictionGeoid),
    index("gov_claims_user_idx").on(t.userId),
  ],
)

export type GovClaimRow = typeof govClaims.$inferSelect
export type NewGovClaimRow = typeof govClaims.$inferInsert
