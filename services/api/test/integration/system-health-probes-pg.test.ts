import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeSystemHealthProbes } from "../../src/services/admin/system-health-probes.js"

const pg = await withPg()

describe.skipIf(!pg)("system health probes (Postgres)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h?.teardown()
  })

  it("T44: the email probe counts only mail sent in the last 7 days", async () => {
    const probe = makeSystemHealthProbes({ getSql: () => h.sql }).ociEmail
    if (probe === undefined) throw new Error("no email probe with a database")
    await h.sql`TRUNCATE mail_events`
    await h.sql`
      INSERT INTO mail_events (type, created_at)
      VALUES
        ('sent', now() - interval '1 hour'),
        ('sent', now() - interval '3 days'),
        ('sent', now() - interval '6 days'),
        ('delivered', now() - interval '1 hour'),
        ('delivered', now() - interval '2 days'),
        ('sent', now() - interval '8 days')
    `
    expect(await probe()).toEqual({ val: "3 sent in the last 7 days", status: "ok" })

    await h.sql`TRUNCATE mail_events`
    expect(await probe()).toEqual({ val: "0 sent in the last 7 days", status: "ok" })
  })
})
