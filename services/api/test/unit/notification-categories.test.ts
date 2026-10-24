// GH#221 / D1: every notification type belongs to one category, or is Always on (null).

import { describe, expect, it } from "vitest"
import { NotificationCategorySchema, NotificationTypeSchema } from "@civfix/contract"
import type { NotificationCategory, NotificationType } from "@civfix/contract"
import { categoryForType } from "../../src/services/notification-categories.js"

const EXPECTED: Record<string, NotificationCategory | null> = {
  report_update: "reportUpdates",
  claim_available: "reportUpdates",
  report_chat: "reportDiscussions",
  dm: "directMessages",
  cleanup_chat: "mentions",
  chat_mention: "mentions",
  post_mention: "mentions",
  post_reply: "mentions",
  post_quote: "mentions",
  group_chat: "groupChats",
  cleanup_reminder: "events",
  cleanup_cancelled: "events",
  cleanup_slot: "events",
  event_broadcast: "hostAnnouncements",
  event_team_invite: "eventTeam",
  cleanup_role: "eventTeam",
  hours_logged: "eventTeam",
  new_follower: "followers",
  post_like: "likesAndReposts",
  post_repost: "likesAndReposts",
  org_invite: "organizations",
  system: null,
}

describe("categoryForType", () => {
  it("T1: maps each of the contract's 22 types exactly as D1", () => {
    const types: readonly NotificationType[] = NotificationTypeSchema.options
    expect(types).toHaveLength(22)
    for (const type of types) {
      expect(type in EXPECTED, `${type} is missing from the expected table`).toBe(true)
      expect(categoryForType(type), type).toBe(EXPECTED[type])
    }
  })

  it("T2: every result is a contract category, and each of the 11 is used", () => {
    const results = NotificationTypeSchema.options.map((type) => categoryForType(type))
    const categories: readonly NotificationCategory[] = NotificationCategorySchema.options
    for (const result of results) {
      if (result !== null) expect(categories).toContain(result)
    }
    expect(categories).toHaveLength(11)
    for (const category of categories) expect(results, category).toContain(category)
  })
})
