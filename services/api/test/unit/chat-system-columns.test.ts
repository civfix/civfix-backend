/**
 * Task D-B1: widen the Drizzle mirror of chat_messages for sender-less SYSTEM messages (report
 * status/timeline events posted into report chat) and sync the related enum tuples. No database
 * needed: this only inspects the Drizzle table config + the const tuples in schema/types.ts.
 *
 * Nothing CONSUMES system_* yet (producers land in D-C1, triggers in D-D1, renderers later); this
 * test only asserts the storage + enum widening this task is responsible for.
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
