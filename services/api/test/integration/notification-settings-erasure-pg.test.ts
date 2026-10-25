/**
 * Erasure removes the account's notification settings and old prefs (D4) inside its transaction. Erasure
 * is a soft delete, so notification_settings' ON DELETE CASCADE never fires and the rows go only through
 * the explicit deletes. T34 runs DELETE /v1/me through the real app over the Postgres auth stores; T35
 * calls PgUserStore directly with a later erasure step made to fail.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { makeServer } from "../../src/server.js"
import { makeContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { PgAuthStores, PgUserStore } from "../../src/auth/pg-stores.js"
import { makeAuthServices, type AuthServices } from "../../src/auth/auth-services.js"

const pg = await withPg()

interface StoredRows {
  settings: { category: string; enabled: boolean; push: boolean; email: boolean }[]
  prefs: { quiet_start: string | null; quiet_end: string | null; tz: string | null }[]
}

describe.skipIf(!pg)("erasure of notification settings and prefs (integration)", () => {
  let h: PgHarness
  let app: FastifyInstance
  let container: Container
  let authServices: AuthServices

  beforeAll(async () => {
    h = pg as PgHarness
    const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: h.uri })
    container = makeContainer(env)
    authServices = makeAuthServices({
      stores: new PgAuthStores(container.getDb().db, {
        certificateObjects: container.storage,
        notifier: container.getNotificationService(),
        jobs: container.jobs,
      }),
      cache: new InMemoryCacheClient(),
      mailer: container.mailer,
      oauthConfig: {},
    })
    app = await makeServer({ env, container, authServices })
  })

  afterAll(async () => {
    await app?.close()
    await h.teardown()
  })

  /** An account with no email (so deleteAccount asks for no code), two settings rows and a prefs row. */
  async function account(): Promise<string> {
    const handle = testHandle()
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${`Resident ${handle}`}, ${handle}) RETURNING id
    `
    const userId = u!.id
    await h.sql`
      INSERT INTO notification_settings (user_id, category, enabled, push, email)
      VALUES (${userId}, 'events', true, false, false), (${userId}, 'followers', true, true, false)
    `
    await h.sql`
      INSERT INTO notification_prefs (user_id, quiet_start, quiet_end, tz)
      VALUES (${userId}, '22:00', '07:00', 'America/Los_Angeles')
    `
    return userId
  }

  async function stored(userId: string): Promise<StoredRows> {
    const settings = await h.sql<StoredRows["settings"]>`
      SELECT category, enabled, push, email FROM notification_settings
      WHERE user_id = ${userId} ORDER BY category
    `
    const prefs = await h.sql<StoredRows["prefs"]>`
      SELECT quiet_start::text AS quiet_start, quiet_end::text AS quiet_end, tz
      FROM notification_prefs WHERE user_id = ${userId}
    `
    return { settings: [...settings], prefs: [...prefs] }
  }

  it("T34: DELETE /v1/me deletes the account's notification_settings and notification_prefs rows, sparing others", async () => {
    const a = await account()
    const b = await account()
    const bBefore = await stored(b)
    expect(bBefore.settings).toHaveLength(2)
    expect(bBefore.prefs).toHaveLength(1)

    const token = await authServices.sessions.createSession(a, ["citizen"])
    const csrfToken = await container.csrf.tokenForSession(token)
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: { cookie: `civfix_session=${token}`, "x-csrf-token": csrfToken },
      payload: { emailOtp: "000000" },
    })
    expect(res.statusCode).toBe(200)

    expect(await stored(a)).toEqual({ settings: [], prefs: [] })
    expect(await stored(b)).toEqual(bBefore)
  })

  it("T35: a later erasure step failing rolls the two deletes back", async () => {
    const a = await account()
    const before = await stored(a)
    expect(before.settings).toHaveLength(2)
    expect(before.prefs).toHaveLength(1)
    await h.sql`
      INSERT INTO posts (author_id, kind, body, visibility) VALUES (${a}, 'post', 'hello', 'public')
    `

    // Hiding the account's public posts runs after the deletes, in the same transaction.
    await h.sql`
      CREATE OR REPLACE FUNCTION t35_fail_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 't35: erasure step failed';
      END
      $$
    `
    await h.sql.unsafe(`
      CREATE TRIGGER t35_fail_erasure BEFORE UPDATE ON posts
      FOR EACH ROW WHEN (OLD.author_id = '${a}'::uuid) EXECUTE FUNCTION t35_fail_erasure()
    `)
    try {
      // Drizzle wraps the database error as the cause of its "Failed query" error.
      await expect(new PgUserStore(h.db).softDeleteAndAnonymize(a)).rejects.toMatchObject({
        cause: { message: "t35: erasure step failed" },
      })
    } finally {
      await h.sql`DROP TRIGGER IF EXISTS t35_fail_erasure ON posts`
      await h.sql`DROP FUNCTION IF EXISTS t35_fail_erasure()`
    }

    expect(await stored(a)).toEqual(before)
  })
})
