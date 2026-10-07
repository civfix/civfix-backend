import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleBroadcastRepository } from "../../src/services/host/broadcast-repository.drizzle.js"
import type { BroadcastRepository } from "../../src/services/host/broadcast-repository.js"

const pg = await withPg()

describe.skipIf(!pg)("host messaging suspension and operator host search (integration)", () => {
  let h: PgHarness
  let repo: BroadcastRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleBroadcastRepository(h.sql)
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(displayName: string): Promise<string> {
    const handle = `u${randomUUID().replace(/-/g, "").slice(0, 15)}`
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${displayName}, ${handle}) RETURNING id`
    return row!.id
  }

  async function suspendedFlag(userId: string): Promise<boolean | null> {
    const rows = await h.sql<{ suspended: boolean }[]>`
      SELECT host_messaging_suspended AS suspended FROM user_moderation WHERE user_id = ${userId}`
    return rows[0]?.suspended ?? null
  }

  async function auditCount(userId: string): Promise<number> {
    const [row] = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log WHERE target = ${`user:${userId}`}`
    return row!.n
  }

  it("commits the suspension and its audit row together", async () => {
    const operator = await newUser("Operator")
    const host = await newUser("Ada Host")

    const found = await repo.setHostMessagingSuspended(host, true, {
      action: "host.messaging_suspended",
      actorId: operator,
      target: `user:${host}`,
      meta: { reason: "spam" },
    })

    expect(found).toBe(true)
    expect(await suspendedFlag(host)).toBe(true)
    expect(await auditCount(host)).toBe(1)
  })

  it("rolls the suspension back when the audit row cannot be written", async () => {
    const host = await newUser("Bea Host")

    await expect(
      repo.setHostMessagingSuspended(host, true, {
        action: "host.messaging_suspended",
        actorId: randomUUID(),
        target: `user:${host}`,
        meta: { reason: "spam" },
      }),
    ).rejects.toThrow()

    expect(await suspendedFlag(host)).toBeNull()
    expect(await auditCount(host)).toBe(0)
  })

  it("reports an unknown user as not found and audits nothing", async () => {
    const operator = await newUser("Operator Two")
    const ghost = randomUUID()

    const found = await repo.setHostMessagingSuspended(ghost, true, {
      action: "host.messaging_suspended",
      actorId: operator,
      target: `user:${ghost}`,
      meta: { reason: "spam" },
    })

    expect(found).toBe(false)
    expect(await suspendedFlag(ghost)).toBeNull()
    expect(await auditCount(ghost)).toBe(0)
  })

  it("treats % and _ in the host search as literal characters", async () => {
    const operator = await newUser("Operator Three")
    const host = await newUser("Cy Literal")
    await repo.setHostMessagingSuspended(host, true, {
      action: "host.messaging_suspended",
      actorId: operator,
      target: `user:${host}`,
    })
    const search = (q: string) =>
      repo.listAdminHosts({
        q,
        suspended: true,
        windowStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
        cursor: null,
        limit: 50,
      })

    expect((await search("Cy Lit")).map((row) => row.userId)).toContain(host)
    expect(await search("%")).toEqual([])
    expect(await search("C_ Literal")).toEqual([])
  })
})
