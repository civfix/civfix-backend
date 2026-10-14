import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"
import { beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import type { Sql } from "../../src/db/client.js"
import {
  MAX_EVENTS_PER_REPORT,
  makeDrizzleCleanupRepository,
} from "../../src/services/cleanup-repository.drizzle.js"
import type { DesiredSlot } from "../../src/services/cleanup-repository.js"
import { makeCleanupService, type CleanupService } from "../../src/services/cleanup-service.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import { makeFakeSql, type FakeSqlControl, type SqlHandler } from "../helpers/fake-sql.js"

const ORG = "11111111-1111-1111-1111-111111111111"
const REPORT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
const DAY_MS = 86_400_000

let repo: InMemoryCleanupRepository
let service: CleanupService
let eventId: string

function saturateReport(reportId: string): void {
  for (let i = 0; i < MAX_EVENTS_PER_REPORT; i += 1) repo.seedLink(randomUUID(), reportId)
}

beforeEach(async () => {
  repo = new InMemoryCleanupRepository()
  repo.seedUser({ id: ORG, displayName: "Olive Organizer", handle: "olive" })
  repo.seedReport({ id: REPORT, title: "Bin 1" })
  service = makeCleanupService({
    tickets: TEST_TICKET_SIGNER,
    repo,
    counters: new InMemoryCounterStore(),
  })
  const created = await service.createCleanup(
    {
      title: "Beach cleanup",
      type: "site",
      eventKind: "cleanup",
      lat: 34.0,
      lng: -118.49,
      scheduledAt: new Date(Date.now() + DAY_MS).toISOString(),
      slots: [{ title: "Volunteers" }],
    },
    ORG,
  )
  eventId = created.id
})

describe("an event edit lands whole or not at all", () => {
  it("keeps the old title when the link cap refuses the same save", async () => {
    saturateReport(REPORT)

    await expect(
      service.updateCleanup(eventId, { title: "Renamed", linkedReportIds: [REPORT] }, ORG),
    ).rejects.toMatchObject({ httpStatus: 422, fields: { linkedReportIds: expect.any(String) } })

    expect(repo.cleanups.get(eventId)?.title).toBe("Beach cleanup")
    expect(repo.links.filter((l) => l.cleanupId === eventId)).toHaveLength(0)
  })

  it("rolls the title and the new links back when the slot board is refused last", async () => {
    repo.reconcileSlots = () => {
      throw AppError.validation({ slots: "duplicate slot title" })
    }

    await expect(
      service.updateCleanup(
        eventId,
        { title: "Renamed", linkedReportIds: [REPORT], slots: [{ title: "Grill" }] },
        ORG,
      ),
    ).rejects.toMatchObject({ httpStatus: 422 })

    expect(repo.cleanups.get(eventId)?.title).toBe("Beach cleanup")
    expect(repo.links.filter((l) => l.cleanupId === eventId)).toHaveLength(0)
    expect(repo.timeline.filter((t) => t.kind === "report_linked")).toHaveLength(0)
  })

  it("refuses an edit to an event cancelled after the service read it", async () => {
    const read = repo.findCleanupById.bind(repo)
    repo.findCleanupById = async (id, near) => {
      const record = await read(id, near)
      const stored = repo.cleanups.get(id)
      if (stored) stored.status = "cancelled"
      return record
    }

    await expect(service.updateCleanup(eventId, { title: "Renamed" }, ORG)).rejects.toMatchObject({
      httpStatus: 409,
    })
    expect(repo.cleanups.get(eventId)?.title).toBe("Beach cleanup")
  })

  it("refuses a frozen field once the event has ended between the read and the write", async () => {
    const read = repo.findCleanupById.bind(repo)
    repo.findCleanupById = async (id, near) => {
      const record = await read(id, near)
      const stored = repo.cleanups.get(id)
      if (stored) {
        stored.scheduledAt = new Date(Date.now() - 2 * DAY_MS)
        stored.endsAt = new Date(Date.now() - DAY_MS)
      }
      return record
    }

    await expect(service.updateCleanup(eventId, { title: "Renamed" }, ORG)).rejects.toMatchObject({
      httpStatus: 409,
    })
    expect(repo.cleanups.get(eventId)?.title).toBe("Beach cleanup")
  })

  it("still saves a description on an event that ended meanwhile", async () => {
    const read = repo.findCleanupById.bind(repo)
    let reads = 0
    repo.findCleanupById = async (id, near) => {
      const record = await read(id, near)
      reads += 1
      const stored = repo.cleanups.get(id)
      if (stored && reads === 1) {
        stored.scheduledAt = new Date(Date.now() - 2 * DAY_MS)
        stored.endsAt = new Date(Date.now() - DAY_MS)
      }
      return record
    }

    const dto = await service.updateCleanup(eventId, { description: "Bring gloves" }, ORG)

    expect(dto.description).toBe("Bring gloves")
  })
})

describe("the Postgres edit runs as one transaction under the event row lock", () => {
  const CLEANUP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
  const SLOT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  const LOCK = /FROM cleanups\s+WHERE id = \? LIMIT 1 FOR NO KEY UPDATE/
  const SLOT_STATEMENT = /cleanup_slots/

  const slot: DesiredSlot = {
    id: SLOT_ID,
    title: "Volunteers",
    description: null,
    capacity: null,
    startsAt: null,
    endsAt: null,
    sortOrder: 0,
  }

  function editSql(extra: SqlHandler[] = []): { fake: FakeSqlControl; begins: () => number } {
    const fake = makeFakeSql([
      ...extra,
      {
        match: LOCK,
        rows: [
          {
            status: "upcoming",
            scheduled_at: new Date(Date.now() + DAY_MS),
            ends_at: new Date(Date.now() + DAY_MS + 3_600_000),
            now: new Date(),
          },
        ],
      },
      { match: /UPDATE cleanups SET/, rows: [{ id: CLEANUP_ID }] },
      {
        match: /SELECT id, title, starts_at, ends_at FROM cleanup_slots/,
        rows: [{ id: SLOT_ID, title: "Volunteers", starts_at: null, ends_at: null }],
      },
    ])
    let opened = 0
    const begin = fake.sql.begin
    fake.sql.begin = <T>(cb: (tx: typeof fake.sql) => Promise<T>): Promise<T> => {
      opened += 1
      return begin(cb)
    }
    return { fake, begins: () => opened }
  }

  it("locks the event first and runs every statement inside one begin", async () => {
    const { fake, begins } = editSql()

    const outcome = await makeDrizzleCleanupRepository(
      fake.sql as unknown as Sql,
    ).updateCleanupWithEdits(
      CLEANUP_ID,
      { title: "Renamed" },
      { actorUserId: ORG, links: [REPORT], slots: [slot], refusalOnceEnded: null },
    )

    expect(outcome.kind).toBe("updated")
    expect(begins()).toBe(1)
    expect(fake.statements[0]?.sql).toMatch(LOCK)
    const texts = fake.statements.map((s) => s.sql)
    const firstSlot = texts.findIndex((t) => SLOT_STATEMENT.test(t))
    expect(texts.findIndex((t) => /UPDATE cleanups SET/.test(t))).toBeGreaterThan(0)
    expect(texts.findIndex((t) => /INSERT INTO cleanup_reports/.test(t))).toBeLessThan(firstSlot)
  })

  it("stops before the slots when the link cap refuses, so the rollback covers the title", async () => {
    const { fake, begins } = editSql([
      { match: /HAVING count\(\*\) >=/, rows: [{ report_id: REPORT }] },
    ])

    await expect(
      makeDrizzleCleanupRepository(fake.sql as unknown as Sql).updateCleanupWithEdits(
        CLEANUP_ID,
        { title: "Renamed" },
        { actorUserId: ORG, links: [REPORT], slots: [slot], refusalOnceEnded: null },
      ),
    ).rejects.toMatchObject({ httpStatus: 422 })

    expect(begins()).toBe(1)
    expect(fake.statements.some((s) => SLOT_STATEMENT.test(s.sql))).toBe(false)
  })

  it("throws the caller's refusal when the locked row shows the event has ended", async () => {
    const refusal = AppError.conflict("ended")
    const { fake } = editSql([
      {
        match: LOCK,
        rows: [
          {
            status: "upcoming",
            scheduled_at: new Date(Date.now() - 2 * DAY_MS),
            ends_at: new Date(Date.now() - DAY_MS),
            now: new Date(),
          },
        ],
      },
    ])

    await expect(
      makeDrizzleCleanupRepository(fake.sql as unknown as Sql).updateCleanupWithEdits(
        CLEANUP_ID,
        { title: "Renamed" },
        { actorUserId: ORG, links: null, slots: null, refusalOnceEnded: refusal },
      ),
    ).rejects.toBe(refusal)

    expect(fake.statements.some((s) => /UPDATE cleanups SET/.test(s.sql))).toBe(false)
  })
})
