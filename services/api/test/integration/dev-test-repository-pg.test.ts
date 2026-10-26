/**
 * The developer console test tools' repository on real Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { FakeMailer } from "@civfix/seams"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleDevTestRepository } from "../../src/services/admin/dev-test-repository.drizzle.js"
import type { DevTestRepository } from "../../src/services/admin/dev-test-repository.js"
import { makeContainer } from "../../src/di.js"
import { PgAuthStores } from "../../src/auth/pg-stores.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { OtpService } from "../../src/auth/otp.js"
import { loadEnv } from "../../src/env.js"

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

  it("T27: the container's test email writes nothing to the mail tables or the mail audit", async () => {
    const operator = await user("operator")
    const [row] = await h.sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${operator}`
    const container = makeContainer(
      loadEnv({
        NODE_ENV: "test",
        CIVFIX_ENV: "staging",
        DEV_TOOLS_ENABLED: "true",
        DATABASE_URL: h.uri,
        // Never dialed: the test email reads no cache.
        REDIS_URL: "redis://127.0.0.1:1",
        MAIL_FROM_NOREPLY: "noreply@staging.test",
      }),
    )
    async function mailState(): Promise<unknown> {
      const [counts] = await h.sql`
        SELECT
          (SELECT count(*)::int FROM mail_messages) AS messages,
          (SELECT count(*)::int FROM mail_threads) AS threads,
          (SELECT count(*)::int FROM mail_events) AS events,
          (SELECT count(*)::int FROM audit_log WHERE action LIKE 'mail.%') AS mail_audits
      `
      return counts
    }
    try {
      const before = await mailState()
      expect(await container.getDevTestTools().sendTestEmail(operator)).toEqual({
        to: row!.email,
      })
      expect((container.mailer as FakeMailer).sent.map((m) => m.outbound)).toEqual([
        {
          from: "noreply@staging.test",
          to: row!.email,
          subject: "civfix test email",
          text: "Sent from the civfix developer console.",
        },
      ])
      expect(await mailState()).toEqual(before)
    } finally {
      await container.close()
    }
  })

  it("T45: short test addresses sign in on Postgres with a valid handle", async () => {
    const stores = new PgAuthStores(h.db)
    const code = "Qm7vT2xRk9LpW4sZc8NbY3hD"
    const otp = new OtpService({
      store: stores.otps,
      users: stores.users,
      identities: stores.oauth,
      cache: new InMemoryCacheClient(),
      mailer: new FakeMailer(),
      testAccounts: { emails: ["qa@civfix.org", "q@civfix.org"], code },
    })
    const qa = await otp.verifyOtp("qa@civfix.org", code, "203.0.113.9")
    const q = await otp.verifyOtp("q@civfix.org", code, "203.0.113.9")
    const rows = await h.sql<{ id: string; handle: string }[]>`
      SELECT id, handle FROM users WHERE id IN (${qa}, ${q})
    `
    expect(Object.fromEntries(rows.map((r) => [r.id, r.handle]))).toEqual({
      [qa]: "qa_2",
      [q]: "q_2",
    })
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
