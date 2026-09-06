import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import type { OrgPaymentsStateValue } from "./types-payments.js"

export const orgStripeAccounts = pgTable(
  "org_stripe_accounts",
  {
    organizationId: uuid("organization_id").primaryKey(),
    stripeAccountId: text("stripe_account_id").notNull(),
    livemode: boolean("livemode").notNull().default(false),
    detailsSubmitted: boolean("details_submitted").notNull().default(false),
    chargesEnabled: boolean("charges_enabled").notNull().default(false),
    payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
    disabledReason: text("disabled_reason"),
    currentlyDue: jsonb("currently_due").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    pastDue: jsonb("past_due").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    pendingVerification: jsonb("pending_verification")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    futureCurrentlyDue: jsonb("future_currently_due")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    capabilities: jsonb("capabilities")
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    currentDeadline: timestamp("current_deadline", { withTimezone: true }),
    onboardingState: text("onboarding_state")
      .$type<OrgPaymentsStateValue>()
      .notNull()
      .default("not_started"),
    paymentMethodDomains: jsonb("payment_method_domains")
      .$type<{ domain: string; id: string; enabled: boolean; registeredAt: string | null }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    deauthorizedAt: timestamp("deauthorized_at", { withTimezone: true }),
    reconnectAttempts: integer("reconnect_attempts").notNull().default(0),
    previousStripeAccountIds: jsonb("previous_stripe_account_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    reconciledThrough: timestamp("reconciled_through", { withTimezone: true }),
    lastAccountEventId: text("last_account_event_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("org_stripe_accounts_account_uidx").on(t.stripeAccountId),
    index("org_stripe_accounts_not_ready_idx")
      .on(t.onboardingState, t.updatedAt.desc())
      .where(sql`onboarding_state <> 'ready'`),
  ],
)

export type OrgStripeAccountRow = typeof orgStripeAccounts.$inferSelect
export type NewOrgStripeAccountRow = typeof orgStripeAccounts.$inferInsert
