import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import type { Db, Sql } from "../../src/db/client.js"
import { makeDrizzleContentSubjectGate } from "../../src/services/content-report-subject.js"

interface EventRow {
  visibility: "public" | "unlisted" | "private"
  status?: string
  event_role?: string | null
  org_role?: string | null
}

function gateOver(event: EventRow | null) {
  const fake = makeFakeSql([
    {
      match: /FROM cleanups/,
      rows:
        event === null
          ? []
          : [
              {
                ok: 1,
                cleanup_id: randomUUID(),
                organizer_user_id: randomUUID(),
                organization_id: null,
                visibility: event.visibility,
                status: event.status ?? "upcoming",
                event_role: event.event_role ?? null,
                org_role: event.org_role ?? null,
              },
            ],
    },
  ])
  return makeDrizzleContentSubjectGate(fake.sql as unknown as Sql, {} as Db)
}

const NOT_FOUND = { httpStatus: 404, message: "Content not found" }

describe("content-report subject gate: events", () => {
  it("answers a non-member's report of a private event exactly like an unknown event", async () => {
    const reporter = randomUUID()
    const subject = randomUUID()

    await expect(
      gateOver({ visibility: "private" }).assertReportable("event", subject, reporter),
    ).rejects.toMatchObject(NOT_FOUND)
    await expect(gateOver(null).assertReportable("event", subject, reporter)).rejects.toMatchObject(
      NOT_FOUND,
    )
  })

  it("lets an event member report a private event", async () => {
    await expect(
      gateOver({ visibility: "private", event_role: "member" }).assertReportable(
        "event",
        randomUUID(),
        randomUUID(),
      ),
    ).resolves.toBeUndefined()
  })

  it("lets a member of the hosting organization report a private event", async () => {
    await expect(
      gateOver({ visibility: "private", org_role: "member" }).assertReportable(
        "event",
        randomUUID(),
        randomUUID(),
      ),
    ).resolves.toBeUndefined()
  })

  it("lets anyone signed in report a public or unlisted event, cancelled ones included", async () => {
    for (const event of [
      { visibility: "public" },
      { visibility: "unlisted" },
      { visibility: "public", status: "cancelled" },
    ] as const) {
      await expect(
        gateOver(event).assertReportable("event", randomUUID(), randomUUID()),
      ).resolves.toBeUndefined()
    }
  })
})
