import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleGuestRsvpRepository } from "../../src/services/guest-rsvp-repository.drizzle.js"
import type { GuestRsvpRepository, UpsertGuestArgs } from "../../src/services/guest-rsvp-service.js"

const pg = await withPg()

describe.skipIf(!pg)("guest rsvp upsert reports whether it inserted (integration)", () => {
  let h: PgHarness
  let repo: GuestRsvpRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleGuestRsvpRepository(h.sql)
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newCleanup(): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Host') RETURNING id
    `
    return seedCleanup(h.sql, {
      organizerUserId: u!.id,
      title: "Guest sweep",
      lng: -118.25,
      lat: 34.05,
      scheduledAt: new Date(Date.now() + 7 * 86_400_000),
    })
  }

  function args(cleanupId: string, tokenHash: string): UpsertGuestArgs {
    return {
      cleanupId,
      name: "Ada",
      channel: "email",
      contactKey: "ada@example.org",
      email: "ada@example.org",
      phone: null,
      manageTokenHash: tokenHash,
      now: new Date(),
    }
  }

  it("is created on the first verify and not on a re-verify of the same active guest", async () => {
    const cleanupId = await newCleanup()

    const first = await repo.upsertVerifiedGuest(args(cleanupId, "a".repeat(64)))
    const again = await repo.upsertVerifiedGuest(args(cleanupId, "b".repeat(64)))

    expect(first.created).toBe(true)
    expect(again).toEqual({ id: first.id, created: false })
  })

  it("is created again once the earlier RSVP was cancelled", async () => {
    const cleanupId = await newCleanup()
    const first = await repo.upsertVerifiedGuest(args(cleanupId, "c".repeat(64)))
    await repo.cancelGuest(first.id, new Date())

    const fresh = await repo.upsertVerifiedGuest(args(cleanupId, "d".repeat(64)))

    expect(fresh.created).toBe(true)
    expect(fresh.id).not.toBe(first.id)
  })
})
