/**
 * Task D-C1: report-chat SYSTEM messages. A system message is a sender-less report status/timeline
 * event stored as a first-class chat_messages row (kind:"system", sender_id NULL, structured
 * system_* payload). `mapSystemRow` is the PURE, DB-free mapper from such a row to a ChatMessageDTO;
 * it is the genuinely new bit this task owns, so it is unit-tested here without any database.
 *
 * The membership SQL (join/leave/isMember/advanceReadWatermark/listMemberIds/countMembers) is exercised
 * by the Docker-gated pg integration suite (test/integration/report-chat-members-pg.test.ts), which
 * SKIPS when Docker is unavailable. This file covers only the pure mapping.
 */

import { describe, expect, it } from "vitest"
import { ReportStatusSchema } from "@civfix/shared"
import { mapSystemRow, type SystemChatRow } from "../../src/services/report-chat-repository.drizzle.js"

const REPORT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const MSG = "dddddddd-dddd-dddd-dddd-dddddddddddd"
const CREATED = new Date("2026-07-09T12:00:00.000Z")

function baseRow(overrides: Partial<SystemChatRow> = {}): SystemChatRow {
  return {
    id: MSG,
    report_id: REPORT,
    body: null,
    created_at: CREATED,
    system_status: "acknowledged",
    system_kind: "status",
    system_body: "Report was acknowledged by the city.",
    ...overrides,
  }
}

describe("mapSystemRow", () => {
  it("maps a system row to a sender-less system ChatMessageDTO", () => {
    const dto = mapSystemRow(baseRow())
    expect(dto.id).toBe(MSG)
    expect(dto.cleanupId).toBe(REPORT)
    expect(dto.roomKind).toBe("report")
    expect(dto.from).toBeNull()
    expect(dto.kind).toBe("system")
    expect(dto.createdAt).toBe(CREATED.toISOString())
  })

  it("carries the structured system payload (status/kind/body)", () => {
    const dto = mapSystemRow(baseRow())
    expect(dto.system).toBeDefined()
    expect(dto.system?.status).toBe("acknowledged")
    expect(dto.system?.kind).toBe("status")
    expect(dto.system?.body).toBe("Report was acknowledged by the city.")
  })

  it("emits empty reactions/mentions arrays", () => {
    const dto = mapSystemRow(baseRow())
    expect(dto.reactions).toEqual([])
    expect(dto.mentions).toEqual([])
  })

  it("uses body as the rendered text when present (note fallback)", () => {
    const dto = mapSystemRow(baseRow({ body: "Report was acknowledged by the city." }))
    expect(dto.body).toBe("Report was acknowledged by the city.")
  })

  it("omits body when the row body is null", () => {
    const dto = mapSystemRow(baseRow({ body: null, system_body: null }))
    expect(dto.body).toBeUndefined()
  })

  it("omits system.kind / system.body when their columns are null", () => {
    const dto = mapSystemRow(baseRow({ system_kind: null, system_body: null }))
    expect(dto.system?.status).toBe("acknowledged")
    expect(dto.system?.kind).toBeUndefined()
    expect(dto.system?.body).toBeUndefined()
  })

  it("never marks a system message as mine (no author)", () => {
    const dto = mapSystemRow(baseRow())
    expect(dto.mine ?? false).toBe(false)
  })
})

/**
 * insertSystemMessage validates input.status against ReportStatusSchema BEFORE writing any row, so a
 * bogus status can never be persisted (making mapSystemRow's status cast sound for the D-D1 timeline
 * writers). The full insert path needs a DB (Docker-gated integration test); this asserts the pure
 * validation contract the guard relies on — DB-free.
 */
describe("insertSystemMessage status validation (ReportStatusSchema guard)", () => {
  it("accepts every report-status the system payload can carry", () => {
    for (const status of [
      "submitted",
      "held",
      "published",
      "acknowledged",
      "in_progress",
      "resolved",
      "rejected",
    ] as const) {
      expect(ReportStatusSchema.parse(status)).toBe(status)
      // The validated status is exactly what mapSystemRow surfaces on the DTO.
      const dto = mapSystemRow(baseRow({ system_status: status }))
      expect(dto.system?.status).toBe(status)
    }
  })

  it("rejects an out-of-vocabulary status (throws before any row is written)", () => {
    expect(() => ReportStatusSchema.parse("not_a_status")).toThrow()
    expect(() => ReportStatusSchema.parse("")).toThrow()
  })
})
