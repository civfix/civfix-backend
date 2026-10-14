/**
 * The Drizzle mirrors of the report-chat membership, per-conversation mute and @city forward audit
 * tables. No database needed: this only inspects the Drizzle table configs.
 */

import { describe, expect, it } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { getTableConfig } from "drizzle-orm/pg-core"
import { reportChatMembers } from "../../src/db/schema/report_chat_members.js"
import { conversationMutes } from "../../src/db/schema/conversation_mutes.js"
import { reportMessageForwards } from "../../src/db/schema/report_message_forwards.js"

function primaryKeyColumnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  const config = getTableConfig(table)
  const pk = config.primaryKeys[0]
  expect(pk, "expected table to declare a composite primaryKey()").toBeDefined()
  return pk!.columns.map((c) => c.name)
}

describe("reportChatMembers Drizzle mirror", () => {
  const columns = getTableColumns(reportChatMembers)

  it("exposes reportId / userId / role / joinedAt / lastReadAt", () => {
    for (const key of ["reportId", "userId", "role", "joinedAt", "lastReadAt"] as const) {
      expect(columns[key], `expected reportChatMembers.${key} to exist`).toBeDefined()
    }
  })

  it("reportId and userId are required uuid columns", () => {
    expect(columns.reportId.notNull).toBe(true)
    expect(columns.reportId.dataType).toBe("string")
    expect(columns.userId.notNull).toBe(true)
    expect(columns.userId.dataType).toBe("string")
  })

  it("role is required and defaults to 'member'", () => {
    expect(columns.role.notNull).toBe(true)
    expect(columns.role.hasDefault).toBe(true)
    expect(columns.role.default).toBe("member")
  })

  it("lastReadAt is nullable", () => {
    expect(columns.lastReadAt.notNull).toBe(false)
  })

  it("primary key is (report_id, user_id)", () => {
    expect(primaryKeyColumnNames(reportChatMembers)).toEqual(["report_id", "user_id"])
  })

  it("has an index on user_id", () => {
    const { indexes } = getTableConfig(reportChatMembers)
    const userIdx = indexes.find((idx) => idx.config.name === "report_chat_members_user_idx")
    expect(userIdx, "expected report_chat_members_user_idx to exist").toBeDefined()
  })
})

describe("conversationMutes Drizzle mirror", () => {
  const columns = getTableColumns(conversationMutes)

  it("exposes userId / roomKind / roomId / mutedAt", () => {
    for (const key of ["userId", "roomKind", "roomId", "mutedAt"] as const) {
      expect(columns[key], `expected conversationMutes.${key} to exist`).toBeDefined()
    }
  })

  it("userId, roomKind, roomId are required", () => {
    expect(columns.userId.notNull).toBe(true)
    expect(columns.roomKind.notNull).toBe(true)
    expect(columns.roomKind.dataType).toBe("string")
    expect(columns.roomId.notNull).toBe(true)
    expect(columns.roomId.dataType).toBe("string")
  })

  it("mutedAt is required and defaults", () => {
    expect(columns.mutedAt.notNull).toBe(true)
    expect(columns.mutedAt.hasDefault).toBe(true)
  })

  it("primary key is (user_id, room_kind, room_id)", () => {
    expect(primaryKeyColumnNames(conversationMutes)).toEqual(["user_id", "room_kind", "room_id"])
  })
})

describe("reportMessageForwards Drizzle mirror", () => {
  const columns = getTableColumns(reportMessageForwards)

  it("exposes messageId / geoid / forwardedAt", () => {
    for (const key of ["messageId", "geoid", "forwardedAt"] as const) {
      expect(columns[key], `expected reportMessageForwards.${key} to exist`).toBeDefined()
    }
  })

  it("messageId and geoid are required, forwardedAt is nullable", () => {
    expect(columns.messageId.notNull).toBe(true)
    expect(columns.messageId.dataType).toBe("string")
    expect(columns.geoid.notNull).toBe(true)
    expect(columns.geoid.dataType).toBe("string")
    expect(columns.forwardedAt.notNull).toBe(false)
  })

  it("messageId has no foreign key reference (chat_messages is partitioned, app-level integrity)", () => {
    const { foreignKeys } = getTableConfig(reportMessageForwards)
    expect(foreignKeys).toHaveLength(0)
  })

  it("primary key is (message_id, geoid)", () => {
    expect(primaryKeyColumnNames(reportMessageForwards)).toEqual(["message_id", "geoid"])
  })
})
