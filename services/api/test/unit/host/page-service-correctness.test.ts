import { describe, expect, it } from "vitest"
import { PAGE_SLUG_MAX, PageSlugSchema } from "@civfix/shared"
import type { EventPageBlock } from "@civfix/shared"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { InMemoryHostRegistrationRepository } from "../../../src/services/host/registration-repository.memory.js"
import {
  HOST_PAGE_PUBLISH_PER_DAY,
  makePageService,
} from "../../../src/services/host/page-service.js"
import { RESERVED_SLUGS } from "../../../src/services/host/slugs.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OTHER_EVENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const THIRD_EVENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const HOST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const MEDIA = "ffffffff-ffff-4fff-8fff-ffffffffffff"
const NOW = new Date("2026-01-01T12:00:00.000Z")

const ABOUT: EventPageBlock = { id: "b1", kind: "about", body: "Bring **gloves**." }

function build() {
  const repo = new InMemoryHostRegistrationRepository()
  repo.seedEvent({ cleanupId: EVENT })
  repo.seedEvent({ cleanupId: OTHER_EVENT })
  repo.seedEvent({ cleanupId: THIRD_EVENT })
  const service = makePageService({
    repo,
    counters: new InMemoryCounterStore(() => NOW.getTime()),
    presignCover: (key) => Promise.resolve({ url: `memory://${key}` }),
    now: () => NOW,
  })
  return { repo, service }
}

describe("the daily publish budget", () => {
  it("is not spent by a publish the page was never ready for", async () => {
    const { service } = build()
    for (let i = 0; i < HOST_PAGE_PUBLISH_PER_DAY; i++) {
      await expect(service.publish({ id: EVENT, published: true }, HOST)).rejects.toMatchObject({
        code: "VALIDATION",
      })
    }

    await service.save({ id: EVENT, slug: "beach-sweep", blocks: [ABOUT] })
    const published = await service.publish({ id: EVENT, published: true }, HOST)

    expect(published.status).toBe("published")
  })
})

describe("publishing a page flagged between the read and the write", () => {
  it("answers 403, not a page", async () => {
    const { repo, service } = build()
    await service.save({ id: EVENT, slug: "beach-sweep", blocks: [ABOUT] })
    repo.publishPage = () => Promise.resolve({ kind: "flagged" })

    await expect(service.publish({ id: EVENT, published: true }, HOST)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "This page is under review and cannot be published.",
    })
  })
})

describe("slug suggestions", () => {
  it("never suggests an address another event already holds", async () => {
    const { repo, service } = build()
    repo.seedEvent({ cleanupId: OTHER_EVENT, pageSlug: "beach-day" })
    repo.seedEvent({ cleanupId: THIRD_EVENT, pageSlug: "beach-day-2" })

    const answer = await service.checkSlug({ id: EVENT, slug: "beach-day" })

    expect(answer).toMatchObject({ available: false, reason: "taken" })
    expect(answer.suggestion).not.toBe("beach-day-2")
    expect(await repo.slugTaken(EVENT, answer.suggestion as string)).toBe(false)
  })

  it("only suggests an address the slug schema accepts", async () => {
    const { repo, service } = build()
    const longest = "a".repeat(PAGE_SLUG_MAX)
    repo.seedEvent({ cleanupId: OTHER_EVENT, pageSlug: longest })

    const answer = await service.checkSlug({ id: EVENT, slug: longest })

    expect(answer.reason).toBe("taken")
    expect(answer.suggestion).not.toBeNull()
    expect(PageSlugSchema.safeParse(answer.suggestion).success).toBe(true)
  })

  it("never suggests a reserved address for a reserved one", async () => {
    const { service } = build()
    for (const reserved of RESERVED_SLUGS) {
      const answer = await service.checkSlug({ id: EVENT, slug: reserved })
      expect(answer.reason).toBe("reserved")
      if (answer.suggestion != null) {
        expect(RESERVED_SLUGS.has(answer.suggestion)).toBe(false)
        expect(PageSlugSchema.safeParse(answer.suggestion).success).toBe(true)
      }
    }
  })
})

describe("block media lookups", () => {
  it("surfaces a database failure instead of rendering the page without its images", async () => {
    const { repo, service } = build()
    repo.mediaKeys.set(MEDIA, "event-media/hero.jpg")
    await service.save({
      id: EVENT,
      slug: "beach-sweep",
      blocks: [{ id: "h1", kind: "hero", mediaId: MEDIA }],
    })
    repo.mediaKeysFor = () => Promise.reject(new Error("connection terminated"))

    await expect(service.get({ id: EVENT })).rejects.toThrow("connection terminated")
  })

  it("still renders the page when only the presign fails", async () => {
    const repo = new InMemoryHostRegistrationRepository()
    repo.seedEvent({ cleanupId: EVENT })
    repo.mediaKeys.set(MEDIA, "event-media/hero.jpg")
    const service = makePageService({
      repo,
      presignCover: () => Promise.reject(new Error("signer offline")),
      now: () => NOW,
    })
    await service.save({
      id: EVENT,
      slug: "beach-sweep",
      blocks: [{ id: "h1", kind: "hero", mediaId: MEDIA }],
    })

    const page = await service.get({ id: EVENT })

    expect(page.blocks).toHaveLength(1)
  })
})
