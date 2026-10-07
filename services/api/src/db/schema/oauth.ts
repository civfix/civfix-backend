import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"

// `provider` stays plain text rather than the OAuthProvider union: the OAuthIdentityStore seam takes a
// string provider, so narrowing would force a cast at every call site for no safety gain. The values
// are still drift-tested via OAUTH_PROVIDER_VALUES in types.ts.
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
