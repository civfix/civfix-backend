/**
 * The Drizzle mirror of chat_messages carries the columns for sender-less SYSTEM messages (report
 * status/timeline events posted into report chat), and the related enum tuples stay in sync. Only the
 * Drizzle table config and the const tuples in schema/types.ts are inspected, so no database is needed.
 */

import { describe, expect, it } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { chatMessages } from "../../src/db/schema/chat.js"
import {
  CHAT_MESSAGE_KIND_VALUES,
  NOTIFICATION_TYPE_VALUES,
  REPORT_CHAT_ROLE_VALUES,
} from "../../src/db/schema/types.js"

describe("chatMessages Drizzle mirror: system-message columns", () => {
  const columns = getTableColumns(chatMessages)

  it("exposes systemStatus / systemKind / systemBody as nullable text columns", () => {
    for (const key of ["systemStatus", "systemKind", "systemBody"] as const) {
      const col = columns[key]
      expect(col, `expected chatMessages.${key} to exist`).toBeDefined()
      expect(col.notNull).toBe(false)
      expect(col.dataType).toBe("string")
    }
  })

  it("senderId is no longer NOT NULL (system messages have no author)", () => {
    expect(columns.senderId.notNull).toBe(false)
  })

  it("reportId / cleanupId remain nullable (unchanged scope columns)", () => {
    expect(columns.reportId.notNull).toBe(false)
    expect(columns.cleanupId.notNull).toBe(false)
  })
})

describe("schema enum tuples: system-message sync", () => {
  it("CHAT_MESSAGE_KIND_VALUES includes 'system'", () => {
    expect(CHAT_MESSAGE_KIND_VALUES).toContain("system")
  })

  it("NOTIFICATION_TYPE_VALUES includes 'report_chat'", () => {
    expect(NOTIFICATION_TYPE_VALUES).toContain("report_chat")
  })

  it("REPORT_CHAT_ROLE_VALUES is exactly ['owner', 'member']", () => {
    expect([...REPORT_CHAT_ROLE_VALUES]).toEqual(["owner", "member"])
  })
})
