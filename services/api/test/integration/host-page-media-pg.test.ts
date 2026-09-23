import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleHostRegistrationRepository } from "../../src/services/host/registration-repository.drizzle.js"
import type { EventPageBlock } from "@civfix/shared"
import type { HostRegistrationRepository } from "../../src/services/host/registration-repository.types.js"

const pg = await withPg()
const FUTURE = new Date(Date.now() + 7 * 86_400_000)

describe.skipIf(!pg)("event page media binding (integration)", () => {
  let h: PgHarness
  let repo: HostRegistrationRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleHostRegistrationRepository(h.sql)
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return (u as { id: string }).id
  }

  async function newCleanup(organizerId: string): Promise<string> {
    return await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Page media sweep",
      lng: -118.25,
      lat: 34.05,
      scheduledAt: FUTURE,
    })
  }

  async function freshUpload(ageSeconds = 0): Promise<{ id: string; r2Key: string }> {
    const id = randomUUID()
    const r2Key = `uploads/2026/09/${id}`
    await h.sql`
      INSERT INTO media_assets (id, upload_id, kind, r2_key, status, byte_size, created_at)
      VALUES (${id}, ${randomUUID()}, 'image', ${r2Key}, 'ready', 10,
              now() - make_interval(secs => ${ageSeconds}))
    `
    return { id, r2Key }
  }

  function sponsorsBlock(mediaId: string): EventPageBlock {
    return {
      id: "b1",
      kind: "sponsors",
      entries: [{ name: "Acme", logoMediaId: mediaId, url: "https://acme.example" }],
    } as EventPageBlock
  }

  it("claims a fresh upload used as a sponsor logo and records the binding", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const logo = await freshUpload()

    const outcome = await repo.savePage({
      cleanupId,
      slug: undefined,
      themeAccent: undefined,
      blocks: [sponsorsBlock(logo.id)],
      blockMediaIds: [logo.id],
      seo: undefined,
      coverMediaId: undefined,
      now: new Date(),
    })
    expect(outcome.kind).toBe("saved")

    const bound = await h.sql<{ media_id: string }[]>`
      SELECT media_id FROM cleanup_page_media WHERE cleanup_id = ${cleanupId}
    `
    expect(bound.map((row) => row.media_id)).toEqual([logo.id])

    const keys = await repo.mediaKeysFor(cleanupId, [logo.id])
    expect(keys.get(logo.id)).toBe(logo.r2Key)
  })

  it("refuses a stale upload nothing on this event ever referenced", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const stale = await freshUpload(24 * 60 * 60)

    const outcome = await repo.savePage({
      cleanupId,
      slug: undefined,
      themeAccent: undefined,
      blocks: [sponsorsBlock(stale.id)],
      blockMediaIds: [stale.id],
      seo: undefined,
      coverMediaId: undefined,
      now: new Date(),
    })
    expect(outcome.kind).toBe("block_media_not_found")
  })

  it("rewrites the binding set on every save", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const first = await freshUpload()
    const second = await freshUpload()

    await repo.savePage({
      cleanupId,
      slug: undefined,
      themeAccent: undefined,
      blocks: [sponsorsBlock(first.id)],
      blockMediaIds: [first.id],
      seo: undefined,
      coverMediaId: undefined,
      now: new Date(),
    })
    await repo.savePage({
      cleanupId,
      slug: undefined,
      themeAccent: undefined,
      blocks: [sponsorsBlock(second.id)],
      blockMediaIds: [second.id],
      seo: undefined,
      coverMediaId: undefined,
      now: new Date(),
    })

    const bound = await h.sql<{ media_id: string }[]>`
      SELECT media_id FROM cleanup_page_media WHERE cleanup_id = ${cleanupId}
    `
    expect(bound.map((row) => row.media_id)).toEqual([second.id])
  })

  it("keeps a swapped-out cover bound while a page block still references it", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const firstCover = await freshUpload()
    const nextCover = await freshUpload()

    await repo.savePage({
      cleanupId,
      slug: undefined,
      themeAccent: undefined,
      blocks: [sponsorsBlock(firstCover.id)],
      blockMediaIds: [firstCover.id],
      seo: undefined,
      coverMediaId: firstCover.id,
      now: new Date(),
    })
    await repo.savePage({
      cleanupId,
      slug: undefined,
      themeAccent: undefined,
      blocks: [sponsorsBlock(firstCover.id)],
      blockMediaIds: [firstCover.id],
      seo: undefined,
      coverMediaId: nextCover.id,
      now: new Date(),
    })

    const keys = await repo.mediaKeysFor(cleanupId, [firstCover.id])
    expect(keys.get(firstCover.id)).toBe(firstCover.r2Key)
  })

  it("never presigns another event's media, even for a ready event_cover", async () => {
    const owner = await newUser("Private host")
    const privateEvent = await newCleanup(owner)
    const cover = await freshUpload()
    await h.sql`
      UPDATE cleanups SET cover_media_id = ${cover.id}, visibility = 'private'
       WHERE id = ${privateEvent}
    `
    await h.sql`UPDATE media_assets SET purpose = 'event_cover' WHERE id = ${cover.id}`

    const stranger = await newUser("Other host")
    const otherEvent = await newCleanup(stranger)

    const keys = await repo.mediaKeysFor(otherEvent, [cover.id])
    expect(keys.size).toBe(0)

    const outcome = await repo.savePage({
      cleanupId: otherEvent,
      slug: undefined,
      themeAccent: undefined,
      blocks: [sponsorsBlock(cover.id)],
      blockMediaIds: [cover.id],
      seo: undefined,
      coverMediaId: undefined,
      now: new Date(),
    })
    expect(outcome.kind).toBe("block_media_not_found")
  })
})
