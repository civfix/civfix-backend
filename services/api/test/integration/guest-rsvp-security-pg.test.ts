import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleGuestRsvpRepository } from "../../src/services/guest-rsvp-repository.drizzle.js"
import type { GuestRsvpRepository } from "../../src/services/guest-rsvp-repository.js"

const pg = await withPg()

describe.skipIf(!pg)("guest rsvp event visibility (integration)", () => {
  let h: PgHarness
  let repo: GuestRsvpRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleGuestRsvpRepository(h.sql)
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("reads the event's visibility and still returns a private event to the notice paths", async () => {
    const [host] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Host') RETURNING id
    `
    const cleanupId = await seedCleanup(h.sql, { organizerUserId: host!.id })

    await expect(repo.findEvent(cleanupId)).resolves.toMatchObject({ visibility: "public" })

    await h.sql`UPDATE cleanups SET visibility = 'private' WHERE id = ${cleanupId}`
    await expect(repo.findEvent(cleanupId)).resolves.toMatchObject({
      id: cleanupId,
      visibility: "private",
    })
  })
})
