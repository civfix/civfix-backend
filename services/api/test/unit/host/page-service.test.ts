import { beforeEach, describe, expect, it } from "vitest"
import { AppError, currentVersion } from "@civfix/shared"
import { parseMarkdownSubset } from "@civfix/shared/markdown"
import type { EventPageBlock } from "@civfix/shared"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { InMemoryHostRegistrationRepository } from "../../../src/services/host/registration-repository.memory.js"
import {
  makePageService,
  validatePageBlocks,
  type PageService,
} from "../../../src/services/host/page-service.js"
import { RESERVED_SLUGS } from "../../../src/services/host/slugs.js"
import { ORGANIZER_STANDING } from "../../../src/services/host/registration-wiring.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OTHER_EVENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const HOST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const STRANGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const MEDIA = "ffffffff-ffff-4fff-8fff-ffffffffffff"
const NOW = new Date("2026-01-01T12:00:00.000Z")

const ABOUT: EventPageBlock = { id: "b1", kind: "about", body: "Bring **gloves**." }

interface Harness {
  repo: InMemoryHostRegistrationRepository
  service: PageService
  team: Set<string>
}

function build(): Harness {
  const repo = new InMemoryHostRegistrationRepository()
  repo.seedEvent({ cleanupId: EVENT })
  repo.seedEvent({ cleanupId: OTHER_EVENT })
  const team = new Set<string>([HOST])
  const service = makePageService({
    repo,
    counters: new InMemoryCounterStore(() => NOW.getTime()),
    standingOf: (_cleanupId: string, userId: string | null) =>
      Promise.resolve(userId !== null && team.has(userId) ? ORGANIZER_STANDING : null),
    presignCover: (key) => Promise.resolve({ url: `memory://${key}` }),
    now: () => NOW,
  })
  return { repo, service, team }
}

describe("event page service", () => {
  let h: Harness

  beforeEach(() => {
    h = build()
  })

  it("saves blocks and a slug, then publishes", async () => {
    await h.service.save({ id: EVENT, slug: "beach-sweep", blocks: [ABOUT] })
    const published = await h.service.publish({ id: EVENT, published: true }, HOST)
    expect(published.status).toBe("published")
    expect(published.slug).toBe("beach-sweep")
  })

  it("refuses to publish without a slug or without any block", async () => {
    await expect(h.service.publish({ id: EVENT, published: true }, HOST)).rejects.toBeInstanceOf(
      AppError,
    )
    await h.service.save({ id: EVENT, slug: "beach-sweep", blocks: [] })
    await expect(
      h.service.publish({ id: EVENT, published: true }, HOST),
    ).rejects.toMatchObject({ fields: { blocks: "add at least one block before publishing" } })
  })

  it("refuses a reserved slug and a slug another event already holds", async () => {
    const reserved = [...RESERVED_SLUGS][0] as string
    await expect(
      h.service.save({ id: EVENT, slug: reserved, blocks: [] }),
    ).rejects.toMatchObject({ fields: { slug: "that address is reserved" } })

    h.repo.seedEvent({ cleanupId: OTHER_EVENT, pageSlug: "taken-slug" })
    await expect(
      h.service.save({ id: EVENT, slug: "taken-slug", blocks: [] }),
    ).rejects.toMatchObject({ fields: { slug: "that address is already taken" } })
  })

  it("reports slug availability without leaking other events", async () => {
    h.repo.seedEvent({ cleanupId: OTHER_EVENT, pageSlug: "taken-slug" })
    expect(await h.service.checkSlug({ id: EVENT, slug: "free-slug" })).toMatchObject({
      available: true,
    })
    expect(await h.service.checkSlug({ id: EVENT, slug: "taken-slug" })).toMatchObject({
      available: false,
      reason: "taken",
    })
    const reserved = [...RESERVED_SLUGS][0] as string
    expect(await h.service.checkSlug({ id: EVENT, slug: reserved })).toMatchObject({
      reason: "reserved",
    })
  })

  it("rejects a non-https external link and a duplicate block id", () => {
    expect(() =>
      validatePageBlocks([{ id: "b1", kind: "donate", url: "http://example.org" }]),
    ).toThrow(AppError)
    expect(() =>
      validatePageBlocks([{ id: "b1", kind: "donate", url: "javascript:alert(1)" }]),
    ).toThrow(AppError)
    expect(() => validatePageBlocks([ABOUT, { ...ABOUT }])).toThrow(AppError)
  })

  it("rejects a third-party image url in a hero, host or sponsor block", () => {
    expect(() =>
      validatePageBlocks([{ id: "b1", kind: "hero", imageUrl: "https://tracker.example/px.gif" }]),
    ).toThrow(AppError)
    expect(() =>
      validatePageBlocks([
        {
          id: "b1",
          kind: "hosts",
          entries: [{ name: "Ada", avatarUrl: "javascript:alert(1)" }],
        },
      ]),
    ).toThrow(AppError)
    expect(() =>
      validatePageBlocks([
        {
          id: "b1",
          kind: "sponsors",
          entries: [{ name: "Acme", logoUrl: "http://10.0.0.5/logo.png" }],
        },
      ]),
    ).toThrow(AppError)
  })

  it("accepts a platform-minted image url and a mediaId reference", () => {
    expect(() =>
      validatePageBlocks(
        [{ id: "b1", kind: "hero", imageUrl: "https://media.civfix.org/covers/a.jpg" }],
        ["https://media.civfix.org/"],
      ),
    ).not.toThrow()
    expect(() =>
      validatePageBlocks([
        {
          id: "b1",
          kind: "hero",
          mediaId: MEDIA,
          imageUrl: "https://media.civfix.org/covers/a.jpg",
        },
      ]),
    ).not.toThrow()
  })

  it("resolves block mediaIds to presigned urls and never stores the resolved url", async () => {
    h.repo.mediaKeys.set(MEDIA, "covers/hero.jpg")
    const saved = await h.service.save({
      id: EVENT,
      blocks: [
        { id: "b1", kind: "hero", mediaId: MEDIA, imageUrl: "https://media.civfix.org/stale.jpg" },
      ],
    })
    const hero = saved.blocks[0] as { imageUrl?: string }
    expect(hero.imageUrl).toBe("memory://covers/hero.jpg")
    const stored = h.repo.pages.get(EVENT)?.blocks[0] as { imageUrl?: string }
    expect(stored.imageUrl).toBeUndefined()
  })

  it("resolves a fresh upload used as a sponsor logo", async () => {
    h.repo.mediaKeys.set(MEDIA, "pages/sponsor.png")
    const saved = await h.service.save({
      id: EVENT,
      blocks: [
        {
          id: "b1",
          kind: "sponsors",
          entries: [{ name: "Acme", logoMediaId: MEDIA, url: "https://acme.example" }],
        },
      ],
    })
    const sponsors = saved.blocks[0] as { entries: { logoUrl?: string }[] }
    expect(sponsors.entries[0]?.logoUrl).toBe("memory://pages/sponsor.png")
  })

  it("does not resolve media bound to another event's page", async () => {
    h.repo.mediaKeys.set(MEDIA, "pages/private-cover.jpg")
    await h.service.save({
      id: OTHER_EVENT,
      blocks: [{ id: "b1", kind: "hero", mediaId: MEDIA }],
    })
    const keys = await h.repo.mediaKeysFor(EVENT, [MEDIA])
    expect(keys.size).toBe(0)
    const theirs = await h.repo.mediaKeysFor(OTHER_EVENT, [MEDIA])
    expect(theirs.get(MEDIA)).toBe("pages/private-cover.jpg")
  })

  it("keeps a swapped-out cover bound while a block still references it", async () => {
    const NEXT_COVER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    h.repo.mediaKeys.set(MEDIA, "covers/first.jpg")
    h.repo.mediaKeys.set(NEXT_COVER, "covers/second.jpg")
    await h.service.save({
      id: EVENT,
      coverMediaId: MEDIA,
      blocks: [{ id: "b1", kind: "hero", mediaId: MEDIA }],
    })
    await h.service.save({
      id: EVENT,
      coverMediaId: NEXT_COVER,
      blocks: [{ id: "b1", kind: "hero", mediaId: MEDIA }],
    })
    const keys = await h.repo.mediaKeysFor(EVENT, [MEDIA])
    expect(keys.get(MEDIA)).toBe("covers/first.jpg")
  })

  it("drops the binding when a block stops referencing the image", async () => {
    h.repo.mediaKeys.set(MEDIA, "pages/hero.jpg")
    await h.service.save({ id: EVENT, blocks: [{ id: "b1", kind: "hero", mediaId: MEDIA }] })
    await h.service.save({ id: EVENT, blocks: [ABOUT] })
    const keys = await h.repo.mediaKeysFor(EVENT, [MEDIA])
    expect(keys.size).toBe(0)
  })

  it("refuses a block mediaId that is not ready platform media", async () => {
    await expect(
      h.service.save({ id: EVENT, blocks: [{ id: "b1", kind: "hero", mediaId: MEDIA }] }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it("keeps an html payload inert text rather than markup", () => {
    const body = "<script>alert(1)</script>"
    expect(() => validatePageBlocks([{ id: "b1", kind: "about", body }])).not.toThrow()
    const parsed = parseMarkdownSubset(body)
    expect(JSON.stringify(parsed)).not.toContain("html")
    expect(parsed.every((node) => node.type === "paragraph" || node.type === "list")).toBe(true)
  })

  it("drops a javascript: link instead of parsing it as a link", () => {
    const parsed = parseMarkdownSubset("[click](javascript:alert(1))")
    expect(JSON.stringify(parsed)).not.toContain('"type":"link"')
  })

  it("accepts the markdown subset the contract allows", () => {
    expect(() =>
      validatePageBlocks([
        { id: "b1", kind: "about", body: "Bring **gloves** and see [the map](https://civfix.org)." },
      ]),
    ).not.toThrow()
  })

  it("404s a public page that is not published, for everyone but the team", async () => {
    await h.service.save({ id: EVENT, slug: "beach-sweep", blocks: [ABOUT] })
    await expect(
      h.service.getPublicEventPage({ slug: "beach-sweep" }, STRANGER),
    ).rejects.toBeInstanceOf(AppError)
    await expect(
      h.service.getPublicEventPage({ slug: "beach-sweep" }, HOST),
    ).resolves.toBeDefined()
  })

  it("404s a draft and a flagged page for a plain member standing", async () => {
    const memberService = makePageService({
      repo: h.repo,
      counters: new InMemoryCounterStore(() => NOW.getTime()),
      standingOf: () => Promise.resolve({ eventRole: "member", orgRole: null }),
      presignCover: (key) => Promise.resolve({ url: `memory://${key}` }),
      now: () => NOW,
    })
    await h.service.save({ id: EVENT, slug: "beach-sweep", blocks: [ABOUT] })

    await expect(
      memberService.getPublicEventPage({ slug: "beach-sweep" }, STRANGER),
    ).rejects.toBeInstanceOf(AppError)

    await h.service.publish({ id: EVENT, published: true }, HOST)
    const page = h.repo.pages.get(EVENT)
    if (page !== undefined) page.flaggedAt = NOW
    await expect(
      memberService.getPublicEventPage({ slug: "beach-sweep" }, STRANGER),
    ).rejects.toBeInstanceOf(AppError)
  })

  it("404s a private event's page for a plain member standing", async () => {
    const memberService = makePageService({
      repo: h.repo,
      counters: new InMemoryCounterStore(() => NOW.getTime()),
      standingOf: () => Promise.resolve({ eventRole: "member", orgRole: null }),
      presignCover: (key) => Promise.resolve({ url: `memory://${key}` }),
      now: () => NOW,
    })
    h.repo.seedEvent({ cleanupId: EVENT, visibility: "private" })
    await h.service.save({ id: EVENT, slug: "beach-sweep", blocks: [ABOUT] })
    await h.service.publish({ id: EVENT, published: true }, HOST)

    await expect(
      memberService.getPublicEventPage({ slug: "beach-sweep" }, STRANGER),
    ).rejects.toBeInstanceOf(AppError)
  })

  it("404s a private event's page for a stranger even when published", async () => {
    h.repo.seedEvent({ cleanupId: EVENT, visibility: "private" })
    await h.service.save({ id: EVENT, slug: "beach-sweep", blocks: [ABOUT] })
    await h.service.publish({ id: EVENT, published: true }, HOST)

    await expect(
      h.service.getPublicEventPage({ slug: "beach-sweep" }, STRANGER),
    ).rejects.toBeInstanceOf(AppError)
    await expect(h.service.getPublicEventPage({ slug: "beach-sweep" }, null)).rejects.toBeInstanceOf(
      AppError,
    )
  })

  it("serves an unlisted event's page with noindex", async () => {
    h.repo.seedEvent({ cleanupId: EVENT, visibility: "unlisted" })
    await h.service.save({ id: EVENT, slug: "beach-sweep", blocks: [ABOUT] })
    await h.service.publish({ id: EVENT, published: true }, HOST)

    const page = await h.service.getPublicEventPage({ slug: "beach-sweep" }, null)
    expect(page.noindex).toBe(true)
    expect(page.seo.noindex).toBe(true)
    expect(page.visibility).toBe("unlisted")
  })

  it("serves the public consent versions and hides hidden ticket types", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT, name: "Public" })
    h.repo.seedTicketType({ cleanupId: EVENT, name: "Hidden", visibility: "hidden" })
    await h.service.save({ id: EVENT, slug: "beach-sweep", blocks: [ABOUT] })
    await h.service.publish({ id: EVENT, published: true }, HOST)

    const page = await h.service.getPublicEventPage({ slug: "beach-sweep" }, null)
    expect(page.ticketTypes.map((type) => type.name)).toEqual(["Public"])
    expect(page.consentVersions).toEqual({
      termsVersion: currentVersion("terms"),
      disclosureVersion: currentVersion("privacy"),
    })
    expect(page.noindex).toBe(false)
  })

  it("caps publishes per host per day", async () => {
    await h.service.save({ id: EVENT, slug: "beach-sweep", blocks: [ABOUT] })
    for (let i = 0; i < 20; i++) {
      await h.service.publish({ id: EVENT, published: i % 2 === 0 }, HOST)
    }
    await expect(h.service.publish({ id: EVENT, published: true }, HOST)).rejects.toThrow(
      /Too many publish changes/u,
    )
  })
})
