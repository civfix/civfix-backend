import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleHostRegistrationRepository } from "../../src/services/host/registration-repository.drizzle.js"
import type { EventPageBlock } from "@civfix/shared"
import type { HostRegistrationRepository } from "../../src/services/host/registration-repository.js"
import { userUploader } from "../../src/services/media-uploader.js"

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

  async function freshUpload(
    over: { ageSeconds?: number; uploader?: string } = {},
  ): Promise<{ id: string; servedKey: string }> {
    const id = randomUUID()
    const servedKey = `served/2026/09/${id}`
    await h.sql`
      INSERT INTO media_assets (
        id, upload_id, kind, r2_key, served_key, status, byte_size, uploader, created_at
      )
      VALUES (${id}, ${randomUUID()}, 'image', ${`uploads/2026/09/${id}`}, ${servedKey}, 'ready', 10,
              ${over.uploader ?? null}, now() - make_interval(secs => ${over.ageSeconds ?? 0}))
    `
    return { id, servedKey }
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
      actorUserId: organizer,
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
    expect(keys.get(logo.id)).toBe(logo.servedKey)
  })

  it("refuses a stale upload nothing on this event ever referenced", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const stale = await freshUpload({ ageSeconds: 24 * 60 * 60 })

    const outcome = await repo.savePage({
      cleanupId,
      actorUserId: organizer,
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
      actorUserId: organizer,
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
      actorUserId: organizer,
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
      actorUserId: organizer,
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
      actorUserId: organizer,
      slug: undefined,
      themeAccent: undefined,
      blocks: [sponsorsBlock(firstCover.id)],
      blockMediaIds: [firstCover.id],
      seo: undefined,
      coverMediaId: nextCover.id,
      now: new Date(),
    })

    const keys = await repo.mediaKeysFor(cleanupId, [firstCover.id])
    expect(keys.get(firstCover.id)).toBe(firstCover.servedKey)
  })

  it("refuses another account's fresh upload as a block image or the cover", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const foreign = await freshUpload({ uploader: userUploader(await newUser("Uploader")) })

    const asBlock = await repo.savePage({
      cleanupId,
      actorUserId: organizer,
      slug: undefined,
      themeAccent: undefined,
      blocks: [sponsorsBlock(foreign.id)],
      blockMediaIds: [foreign.id],
      seo: undefined,
      coverMediaId: undefined,
      now: new Date(),
    })
    expect(asBlock.kind).toBe("block_media_not_found")

    const asCover = await repo.savePage({
      cleanupId,
      actorUserId: organizer,
      slug: undefined,
      themeAccent: undefined,
      blocks: [],
      blockMediaIds: [],
      seo: undefined,
      coverMediaId: foreign.id,
      now: new Date(),
    })
    expect(asCover.kind).toBe("cover_not_found")

    const [row] = await h.sql<{ purpose: string }[]>`
      SELECT purpose FROM media_assets WHERE id = ${foreign.id}
    `
    expect(row!.purpose).toBe("report")
  })

  it("claims the saving host's own attributed upload", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const own = await freshUpload({ uploader: userUploader(organizer) })

    const outcome = await repo.savePage({
      cleanupId,
      actorUserId: organizer,
      slug: undefined,
      themeAccent: undefined,
      blocks: [sponsorsBlock(own.id)],
      blockMediaIds: [own.id],
      seo: undefined,
      coverMediaId: own.id,
      now: new Date(),
    })
    expect(outcome.kind).toBe("saved")
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
      actorUserId: stranger,
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
