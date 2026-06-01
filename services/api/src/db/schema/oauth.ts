/**
 * oauth_identities: external identity-provider links (Apple, Google) for a user.
 *
 * A user may have multiple identities (one per provider). The (provider, provider_user_id) pair is
 * globally unique so the same external account cannot be attached to two civfix users.
 */

import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"

// NOTE: `provider` is intentionally left as plain `text` (NOT $type-narrowed to the shared
// OAuthProvider union). The OAuthIdentityStore seam queries/links by a `string` provider (the
// OAuthService passes its PROVIDER_* string constants), so narrowing the column would force a cast at
// every call site for no real safety gain. The values are still mirrored + drift-tested via
// OAUTH_PROVIDER_VALUES in db/schema/types.ts.
export const oauthIdentities = pgTable(
  "oauth_identities",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("oauth_identities_provider_user_key").on(t.provider, t.providerUserId),
    index("oauth_identities_user_idx").on(t.userId),
  ],
)

export type OAuthIdentityRow = typeof oauthIdentities.$inferSelect
export type NewOAuthIdentityRow = typeof oauthIdentities.$inferInsert
