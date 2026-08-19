import { afterAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { PgUserStore } from "../../src/auth/pg-stores.js"

const pg = await withPg()

describe.skipIf(!pg)("F135 PgUserStore.updateSettings against the real schema", () => {
  const h = pg as PgHarness

  afterAll(async () => {
    await h.teardown()
  })

  it("an empty settings patch is a no-op that returns the current record", async () => {
    const users = new PgUserStore(h.db)
    const user = await users.create("settings.empty@example.com", { displayName: "Settings IT" })
    const seeded = await users.updateSettings(user.id, {
      allowDirectMessages: false,
      locale: "es",
      showVolunteerHours: false,
    })
    expect(seeded.allowDirectMessages).toBe(false)

    const unchanged = await users.updateSettings(user.id, {})

    expect(unchanged.id).toBe(user.id)
    expect(unchanged.allowDirectMessages).toBe(false)
    expect(unchanged.locale).toBe("es")
    expect(unchanged.showVolunteerHours).toBe(false)
  })

  it("a single-field patch still writes only that field", async () => {
    const users = new PgUserStore(h.db)
    const user = await users.create("settings.single@example.com", { displayName: "Settings IT 2" })
    await users.updateSettings(user.id, { locale: "es", allowDirectMessages: false })

    const updated = await users.updateSettings(user.id, { allowDirectMessages: true })

    expect(updated.allowDirectMessages).toBe(true)
    expect(updated.locale).toBe("es")
  })
})
