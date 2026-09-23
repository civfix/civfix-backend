import { describe, expect, it } from "vitest"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleBroadcastRepository } from "../../src/services/host/broadcast-repository.drizzle.js"
import { InMemoryBroadcastRepository } from "../../src/services/host/broadcast-repository.memory.js"
import { makeFakeSql } from "../helpers/fake-sql.js"

describe("operator host search", () => {
  it("matches % and _ literally instead of as wildcards", async () => {
    const fake = makeFakeSql()
    const repo = makeDrizzleBroadcastRepository(fake.sql as unknown as Sql)

    await repo.listAdminHosts({
      q: "50%_off\\",
      windowStart: new Date("2026-09-01T00:00:00Z"),
      cursor: null,
      limit: 10,
    })

    const statement = fake.statements[0]
    expect(statement?.sql).toMatch(/u\.display_name ILIKE \? ESCAPE '\\'/)
    expect(statement?.sql).toMatch(/u\.handle ILIKE \? ESCAPE '\\'/)
    expect(statement?.values).toContain("%50\\%\\_off\\\\%")
    expect(statement?.values).not.toContain("%50%_off\\%")
  })
})

describe("in-memory host messaging suspension", () => {
  const KNOWN_HOST = "00000000-0000-0000-0000-0000000000aa"
  const UNKNOWN_USER = "00000000-0000-0000-0000-0000000000bb"
  const OPERATOR = "00000000-0000-0000-0000-0000000000cc"

  it("returns false and records no audit row for an unknown user", async () => {
    const repo = new InMemoryBroadcastRepository()

    const found = await repo.setHostMessagingSuspended(UNKNOWN_USER, true, {
      action: "host.messaging_suspended",
      actorId: OPERATOR,
      target: `user:${UNKNOWN_USER}`,
    })

    expect(found).toBe(false)
    expect(repo.audits).toHaveLength(0)
    expect(await repo.hostMessagingState(UNKNOWN_USER)).toBeNull()
  })

  it("suspends a known host and records the audit row", async () => {
    const repo = new InMemoryBroadcastRepository()
    repo.seedHost(KNOWN_HOST)

    const found = await repo.setHostMessagingSuspended(KNOWN_HOST, true, {
      action: "host.messaging_suspended",
      actorId: OPERATOR,
      target: `user:${KNOWN_HOST}`,
    })

    expect(found).toBe(true)
    expect(repo.audits.map((a) => a.action)).toEqual(["host.messaging_suspended"])
    expect((await repo.hostMessagingState(KNOWN_HOST))?.suspended).toBe(true)
  })
})
