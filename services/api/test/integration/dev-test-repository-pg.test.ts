/**
 * The developer console test tools' repository on real Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleDevTestRepository } from "../../src/services/admin/dev-test-repository.drizzle.js"
import type { DevTestRepository } from "../../src/services/admin/dev-test-repository.js"

const pg = await withPg()

describe.skipIf(!pg)("dev test tools repository (integration)", () => {
  let h: PgHarness
  let repo: DevTestRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleDevTestRepository(h.sql)
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function user(role: "citizen" | "operator" = "citizen"): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, email, role, profile_complete)
      VALUES ('Tester', ${testHandle()}, ${`${randomUUID()}@civfix.org`}, ${role}, true)
      RETURNING id
    `
    return u!.id
  }

  async function token(userId: string, revoked: boolean): Promise<void> {
    await h.sql`
      INSERT INTO push_tokens (user_id, platform, token, revoked_at)
      VALUES (${userId}, 'ios', ${randomUUID()}, ${revoked ? new Date() : null})
    `
  }

  async function profileComplete(userId: string): Promise<boolean> {
    const [row] = await h.sql<{ profile_complete: boolean }[]>`
      SELECT profile_complete FROM users WHERE id = ${userId}
    `
    return row!.profile_complete
  }

  it("T26: counts only the account's tokens that are not revoked", async () => {
    const tester = await user()
    const other = await user()
    const none = await user()
    await token(tester, false)
    await token(tester, false)
    await token(tester, true)
    await token(other, false)
    expect(await repo.countActivePushDevices(tester)).toBe(2)
    expect(await repo.countActivePushDevices(none)).toBe(0)
  })

  it("T31: resets only the account it names, and audits it", async () => {
    const operator = await user("operator")
    const reset = await user()
    const kept = await user()
    await repo.resetFirstRun({ userId: reset, actorId: operator })
    expect(await profileComplete(reset)).toBe(false)
    expect(await profileComplete(kept)).toBe(true)
    const audits = await h.sql<{ actor_id: string; target: string; meta: unknown }[]>`
      SELECT actor_id, target, meta FROM audit_log WHERE action = 'dev.reset_first_run'
    `
    expect([...audits]).toEqual([{ actor_id: operator, target: `user:${reset}`, meta: null }])
  })

  it("finds a live account by its address and an address by its account", async () => {
    const id = await user()
    const [row] = await h.sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${id}`
    expect(await repo.findAccountIdByEmail(row!.email)).toBe(id)
    expect(await repo.findEmailById(id)).toBe(row!.email)
    expect(await repo.findAccountIdByEmail("nobody@civfix.org")).toBe(null)
    await h.sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`
    expect(await repo.findAccountIdByEmail(row!.email)).toBe(null)
  })
})
