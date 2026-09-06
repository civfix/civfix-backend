import { describe, expect, it } from "vitest"
import type { Sql } from "../../../src/db/client.js"
import {
  ANSWER_RETENTION_DAYS,
  HOST_NOTE_RETENTION_DAYS,
  REGISTRATION_RETENTION_BATCH,
  REGISTRATION_RETENTION_MAX_PAGES,
  runRegistrationRetentionLanes,
} from "../../../src/services/host/registration-retention.js"

const NOW = new Date("2026-06-01T04:25:00.000Z")
const DAY_MS = 24 * 60 * 60 * 1000

interface Recorded {
  text: string
  values: unknown[]
}

function stubSql(rowsPerCall: number[]): { sql: Sql; calls: Recorded[] } {
  const calls: Recorded[] = []
  let index = 0
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const count = rowsPerCall[index] ?? 0
    index += 1
    calls.push({ text: strings.join("?"), values })
    return Promise.resolve(Array.from({ length: count }, (_unused, i) => ({ id: `row-${i}` })))
  }
  return { sql: tag as unknown as Sql, calls }
}

function cutoffsOf(call: Recorded): Date[] {
  return call.values.filter((value): value is Date => value instanceof Date)
}

describe("registration retention lanes", () => {
  it("runs the four lanes in order with clock-derived cutoffs", async () => {
    const { sql, calls } = stubSql([1, 1, 1, 1])
    const result = await runRegistrationRetentionLanes(sql, NOW)

    expect(result).toEqual({
      scrubbedAnswers: 1,
      coarsenedCheckins: 1,
      clearedAttendeeNames: 1,
      clearedHostNotes: 1,
    })
    expect(calls).toHaveLength(4)
    expect(calls[0]?.text).toContain("cleanup_answers")
    expect(calls[1]?.text).toContain("checkin_coarsened_at")
    expect(calls[2]?.text).toContain("attendee_name = NULL")
    expect(calls[3]?.text).toContain("host_note = NULL")

    const answerCutoff = cutoffsOf(calls[0] as Recorded).find((d) => d.getTime() < NOW.getTime())
    expect(answerCutoff?.getTime()).toBe(NOW.getTime() - ANSWER_RETENTION_DAYS * DAY_MS)

    const noteCutoff = cutoffsOf(calls[3] as Recorded).find((d) => d.getTime() < NOW.getTime())
    expect(noteCutoff?.getTime()).toBe(NOW.getTime() - HOST_NOTE_RETENTION_DAYS * DAY_MS)
  })

  it("keeps draining a lane while it returns a full batch, up to the page ceiling", async () => {
    const full = Array.from({ length: REGISTRATION_RETENTION_MAX_PAGES + 5 }, () =>
      REGISTRATION_RETENTION_BATCH,
    )
    const { sql } = stubSql(full)
    const warnings: unknown[] = []

    const result = await runRegistrationRetentionLanes(sql, NOW, {
      warn: (obj) => warnings.push(obj),
    })

    expect(result.scrubbedAnswers).toBe(
      REGISTRATION_RETENTION_MAX_PAGES * REGISTRATION_RETENTION_BATCH,
    )
    expect(warnings.length).toBeGreaterThan(0)
  })

  it("never throws when a lane fails and still runs the lanes after it", async () => {
    const calls: string[] = []
    let index = 0
    const tag = (strings: TemplateStringsArray): Promise<unknown[]> => {
      calls.push(strings.join("?"))
      index += 1
      if (index === 1) return Promise.reject(new Error("deadlock detected"))
      return Promise.resolve([{ id: "row" }])
    }
    const warnings: unknown[] = []

    const result = await runRegistrationRetentionLanes(tag as unknown as Sql, NOW, {
      warn: (obj) => warnings.push(obj),
    })

    expect(result.scrubbedAnswers).toBe(0)
    expect(result.coarsenedCheckins).toBe(1)
    expect(result.clearedAttendeeNames).toBe(1)
    expect(result.clearedHostNotes).toBe(1)
    expect(warnings).toHaveLength(1)
  })
})
