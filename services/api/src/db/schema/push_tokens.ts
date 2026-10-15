/** `revoked_at` soft-revokes a token so the row stays as the device audit trail. */

import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"
import type { PUSH_PLATFORM_VALUES } from "./types.js"

type PushPlatform = (typeof PUSH_PLATFORM_VALUES)[number]

export const pushTokens = pgTable(
  "push_tokens",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    platform: text("platform").$type<PushPlatform>().notNull(),
    token: text("token").notNull(),
    deviceId: text("device_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("push_tokens_platform_token_key").on(t.platform, t.token),
    index("push_tokens_user_idx").on(t.userId),
    index("push_tokens_active_token_idx")
      .on(t.token)
      .where(sql`${t.revokedAt} is null`),
  ],
)

export type PushTokenRow = typeof pushTokens.$inferSelect
export type NewPushTokenRow = typeof pushTokens.$inferInsert
