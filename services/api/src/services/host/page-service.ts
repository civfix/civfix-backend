import { AppError, MAX_EVENT_PAGE_BLOCKS, PAGE_SLUG_MAX, PageSlugSchema } from "@civfix/shared"
import type {
  CheckEventPageSlugRequest,
  CheckEventPageSlugResponse,
  EventPageBlock,
  EventPageDTO,
  GetEventPageRequest,
  GetPublicEventPageRequest,
  PublicEventPageDTO,
  PublishEventPageRequest,
  SaveEventPageRequest,
} from "@civfix/shared"
import { currentVersion } from "@civfix/shared"
import { parseMarkdownSubset, MARKDOWN_SUBSET_MAX_CHARS } from "@civfix/shared/markdown"
import { can, type HostStanding } from "@civfix/shared/host"
import { assertNoSlur } from "../../abuse/slur-filter.js"
import { mapWithLimit, PRESIGN_CONCURRENCY } from "../media-presign.js"
import { RESERVED_SLUGS } from "./slugs.js"
import type { CounterStore } from "../../abuse/counter-store.js"
import { toEventPageDTO, toEventQuestionDTO, toPublicTicketType } from "./registration-dto.js"
import type { HostRegistrationRepository, PageRecord } from "./registration-repository.types.js"
import type { RegistrationAudit } from "./registration-service.js"

export const HOST_PAGE_PUBLISH_COUNTER_KEY = "host:pagePublish"

export const HOST_PAGE_PUBLISH_PER_DAY = 20

export const DAY_SECONDS = 24 * 60 * 60

const RESERVED_SLUG_SUFFIXES = ["-event", "-2", "-3"] as const

const TAKEN_SLUG_SUFFIXES = ["-2", "-3", "-4"] as const

function pageUnderReviewError(): AppError {
  return AppError.forbidden("This page is under review and cannot be published.")
}

function slugWithSuffix(slug: string, suffix: string): string | null {
  const base = slug.slice(0, PAGE_SLUG_MAX - suffix.length).replace(/-+$/u, "")
  const candidate = `${base}${suffix}`
  return PageSlugSchema.safeParse(candidate).success ? candidate : null
}

export interface PageServiceDeps {
  repo: HostRegistrationRepository
  presignCover?: (r2Key: string) => Promise<{ url: string }>
  standingOf?: (cleanupId: string, userId: string | null) => Promise<HostStanding | null>
  mediaUrlPrefixes?: readonly string[]
  counters?: CounterStore
  audit?: RegistrationAudit
  now?: () => Date
  logger?: { warn(obj: unknown, msg?: string): void }
}

export interface PageService {
  get(query: GetEventPageRequest): Promise<EventPageDTO>
  save(input: SaveEventPageRequest, actorId: string): Promise<EventPageDTO>
  publish(input: PublishEventPageRequest, actorId: string): Promise<EventPageDTO>
  checkSlug(query: CheckEventPageSlugRequest): Promise<CheckEventPageSlugResponse>
  getPublicEventPage(
    query: GetPublicEventPageRequest,
    viewerUserId: string | null,
  ): Promise<PublicEventPageDTO>
}

function markdownFields(block: EventPageBlock): string[] {
  switch (block.kind) {
    case "about":
      return [block.body]
    case "agenda":
      return block.items.flatMap((item) => [item.title, item.description ?? ""])
    case "hosts":
      return block.entries.flatMap((entry) => [entry.name, entry.bio ?? ""])
    case "faq":
      return block.items.flatMap((item) => [item.question, item.answer])
    case "location":
      return [block.note ?? ""]
    case "sponsors":
      return block.entries.map((entry) => entry.name)
    case "donate":
      return [block.blurb ?? ""]
    case "registration":
      return [block.note ?? ""]
    case "contact":
      return [block.body ?? ""]
    case "hero":
      return [block.headline ?? "", block.subhead ?? ""]
  }
}

export function blockMediaIds(blocks: readonly EventPageBlock[]): string[] {
  const ids: string[] = []
  for (const block of blocks) {
    if (block.kind === "hero" && block.mediaId != null) ids.push(block.mediaId)
    if (block.kind === "hosts") {
      for (const entry of block.entries) {
        if (entry.avatarMediaId != null) ids.push(entry.avatarMediaId)
      }
    }
    if (block.kind === "sponsors") {
      for (const entry of block.entries) {
        if (entry.logoMediaId != null) ids.push(entry.logoMediaId)
      }
    }
  }
  return [...new Set(ids)]
}

interface BlockMediaUrl {
  field: string
  url: string
  hasMediaId: boolean
}

function mediaUrlFields(block: EventPageBlock): BlockMediaUrl[] {
  if (block.kind === "hero") {
    return block.imageUrl == null
      ? []
      : [{ field: "imageUrl", url: block.imageUrl, hasMediaId: block.mediaId != null }]
  }
  if (block.kind === "hosts") {
    return block.entries.flatMap((entry, index) =>
      entry.avatarUrl == null
        ? []
        : [
            {
              field: `entries.${index}.avatarUrl`,
              url: entry.avatarUrl,
              hasMediaId: entry.avatarMediaId != null,
            },
          ],
    )
  }
  if (block.kind === "sponsors") {
    return block.entries.flatMap((entry, index) =>
      entry.logoUrl == null
        ? []
        : [
            {
              field: `entries.${index}.logoUrl`,
              url: entry.logoUrl,
              hasMediaId: entry.logoMediaId != null,
            },
          ],
    )
  }
  return []
}

export function stripResolvedMediaUrls(blocks: readonly EventPageBlock[]): EventPageBlock[] {
  return blocks.map((block) => {
    if (block.kind === "hero" && block.mediaId != null && block.imageUrl != null) {
      const { imageUrl: _dropped, ...rest } = block
      return rest
    }
    if (block.kind === "hosts") {
      return {
        ...block,
        entries: block.entries.map((entry) => {
          if (entry.avatarMediaId == null || entry.avatarUrl == null) return entry
          const { avatarUrl: _dropped, ...rest } = entry
          return rest
        }),
      }
    }
    if (block.kind === "sponsors") {
      return {
        ...block,
        entries: block.entries.map((entry) => {
          if (entry.logoMediaId == null || entry.logoUrl == null) return entry
          const { logoUrl: _dropped, ...rest } = entry
          return rest
        }),
      }
    }
    return block
  })
}

function externalUrls(block: EventPageBlock): { field: string; url: string }[] {
  if (block.kind === "donate") {
    return block.url == null ? [] : [{ field: "url", url: block.url }]
  }
  if (block.kind === "sponsors") {
    return block.entries.flatMap((entry, index) =>
      entry.url == null ? [] : [{ field: `entries.${index}.url`, url: entry.url }],
    )
  }
  return []
}

export function validatePageBlocks(
  blocks: readonly EventPageBlock[],
  mediaUrlPrefixes: readonly string[] = [],
): void {
  if (blocks.length > MAX_EVENT_PAGE_BLOCKS) {
    throw AppError.validation({ blocks: `at most ${MAX_EVENT_PAGE_BLOCKS} blocks` })
  }
  const ids = new Set<string>()
  for (const [index, block] of blocks.entries()) {
    if (ids.has(block.id)) {
      throw AppError.validation({ [`blocks.${index}.id`]: "duplicate block id" })
    }
    ids.add(block.id)

    for (const text of markdownFields(block)) {
      if (text.length === 0) continue
      if (text.length > MARKDOWN_SUBSET_MAX_CHARS) {
        throw AppError.validation({
          [`blocks.${index}`]: `text must be at most ${MARKDOWN_SUBSET_MAX_CHARS} characters`,
        })
      }
      assertNoSlur(text, `blocks.${index}`)
      if (parseMarkdownSubset(text).length === 0) {
        throw AppError.validation({
          [`blocks.${index}`]: "contains no renderable text once markup is removed",
        })
      }
    }

    for (const link of externalUrls(block)) {
      if (!link.url.startsWith("https://")) {
        throw AppError.validation({
          [`blocks.${index}.${link.field}`]: "must be an https:// link",
        })
      }
    }

    for (const media of mediaUrlFields(block)) {
      if (media.hasMediaId) continue
      if (mediaUrlPrefixes.some((prefix) => media.url.startsWith(prefix))) continue
      throw AppError.validation({
        [`blocks.${index}.${media.field}`]:
          "must reference platform media — upload the image and send its mediaId",
      })
    }
  }
}

export function makePageService(deps: PageServiceDeps): PageService {
  const now = deps.now ?? (() => new Date())

  async function coverUrlOf(record: PageRecord): Promise<string | null> {
    if (record.coverKey === null || deps.presignCover === undefined) return null
    // A signing failure costs the page its image, never the page: presigning is decoration.
    try {
      return (await deps.presignCover(record.coverKey)).url
    } catch (err) {
      deps.logger?.warn({ err }, "event page: cover presign failed (suppressed)")
      return null
    }
  }

  async function resolveBlockMedia(
    cleanupId: string,
    blocks: readonly EventPageBlock[],
  ): Promise<EventPageBlock[]> {
    const ids = blockMediaIds(blocks)
    if (ids.length === 0 || deps.presignCover === undefined) return [...blocks]
    const keys = await deps.repo.mediaKeysFor(cleanupId, ids)
    const urls = new Map<string, string>()
    await mapWithLimit([...keys.entries()], PRESIGN_CONCURRENCY, async ([id, key]) => {
      try {
        urls.set(
          id,
          (await (deps.presignCover as (k: string) => Promise<{ url: string }>)(key)).url,
        )
      } catch (err) {
        deps.logger?.warn({ err }, "event page: block media presign failed (suppressed)")
      }
    })

    return blocks.map((block) => {
      if (block.kind === "hero") {
        const url = block.mediaId == null ? undefined : urls.get(block.mediaId)
        return url === undefined ? block : { ...block, imageUrl: url }
      }
      if (block.kind === "hosts") {
        return {
          ...block,
          entries: block.entries.map((entry) => {
            const url = entry.avatarMediaId == null ? undefined : urls.get(entry.avatarMediaId)
            return url === undefined ? entry : { ...entry, avatarUrl: url }
          }),
        }
      }
      if (block.kind === "sponsors") {
        return {
          ...block,
          entries: block.entries.map((entry) => {
            const url = entry.logoMediaId == null ? undefined : urls.get(entry.logoMediaId)
            return url === undefined ? entry : { ...entry, logoUrl: url }
          }),
        }
      }
      return block
    })
  }

  async function pageDTO(record: PageRecord): Promise<EventPageDTO> {
    return toEventPageDTO(
      { ...record, blocks: await resolveBlockMedia(record.cleanupId, record.blocks) },
      await coverUrlOf(record),
    )
  }

  async function freeSlugSuggestion(
    cleanupId: string,
    slug: string,
    suffixes: readonly string[],
  ): Promise<string | null> {
    for (const suffix of suffixes) {
      const candidate = slugWithSuffix(slug, suffix)
      if (candidate === null || RESERVED_SLUGS.has(candidate)) continue
      if (!(await deps.repo.slugTaken(cleanupId, candidate))) return candidate
    }
    return null
  }

  async function reservePublishBudget(actorId: string): Promise<void> {
    if (deps.counters === undefined) return
    let used: number
    try {
      used = await deps.counters.incr(`${HOST_PAGE_PUBLISH_COUNTER_KEY}:${actorId}`, DAY_SECONDS)
    } catch (err) {
      deps.logger?.warn({ err }, "event page: publish counter unavailable; refusing (fail closed)")
      throw AppError.rateLimited("Publishing is temporarily unavailable.")
    }
    if (used > HOST_PAGE_PUBLISH_PER_DAY) {
      throw AppError.rateLimited("Too many publish changes today.")
    }
  }

  return {
    async get(query): Promise<EventPageDTO> {
      const record = await deps.repo.getPage(query.id)
      if (record === null) throw AppError.notFound("Cleanup not found")
      return pageDTO(record)
    },

    async save(input, actorId): Promise<EventPageDTO> {
      validatePageBlocks(input.blocks, deps.mediaUrlPrefixes ?? [])
      if (input.slug != null && RESERVED_SLUGS.has(input.slug)) {
        throw AppError.validation({ slug: "that address is reserved" })
      }

      const blocks = stripResolvedMediaUrls(input.blocks)
      const outcome = await deps.repo.savePage({
        cleanupId: input.id,
        actorUserId: actorId,
        slug: input.slug,
        themeAccent: input.theme?.accent,
        blocks,
        blockMediaIds: blockMediaIds(blocks),
        seo: input.seo,
        coverMediaId: input.coverMediaId,
        now: now(),
      })
      switch (outcome.kind) {
        case "saved":
          return pageDTO(outcome.record)
        case "slug_taken":
          throw AppError.validation({ slug: "that address is already taken" })
        case "cover_not_found":
          throw AppError.validation({ coverMediaId: "not a ready event cover image" })
        case "block_media_not_found":
          throw AppError.validation({ blocks: "one of the block images is not ready event media" })
        case "not_found":
          throw AppError.notFound("Cleanup not found")
      }
    },

    async publish(input, actorId): Promise<EventPageDTO> {
      const current = await deps.repo.getPage(input.id)
      if (current === null) throw AppError.notFound("Cleanup not found")
      if (input.published) {
        if (current.slug === null) {
          throw AppError.validation({ slug: "set a page address before publishing" })
        }
        if (current.blocks.length === 0) {
          throw AppError.validation({ blocks: "add at least one block before publishing" })
        }
        if (current.flaggedAt !== null) throw pageUnderReviewError()
      }

      await reservePublishBudget(actorId)
      const outcome = await deps.repo.publishPage({
        cleanupId: input.id,
        published: input.published,
        actorId,
        now: now(),
      })
      if (outcome.kind === "not_found") throw AppError.notFound("Cleanup not found")
      if (outcome.kind === "flagged") throw pageUnderReviewError()
      const record = outcome.record
      await deps.audit?.({
        actorId,
        action: "event.page_published",
        target: `cleanup:${input.id}`,
        meta: { published: input.published, slug: record.slug },
      })
      return pageDTO(record)
    },

    async checkSlug(query): Promise<CheckEventPageSlugResponse> {
      if (RESERVED_SLUGS.has(query.slug)) {
        return {
          available: false,
          reason: "reserved",
          suggestion: await freeSlugSuggestion(query.id, query.slug, RESERVED_SLUG_SUFFIXES),
        }
      }
      const taken = await deps.repo.slugTaken(query.id, query.slug)
      if (!taken) return { available: true, reason: null, suggestion: null }
      return {
        available: false,
        reason: "taken",
        suggestion: await freeSlugSuggestion(query.id, query.slug, TAKEN_SLUG_SUFFIXES),
      }
    },

    async getPublicEventPage(query, viewerUserId): Promise<PublicEventPageDTO> {
      const notFound = AppError.notFound("Page not found")
      const record = await deps.repo.getPublicPage(query.slug)
      if (record === null) throw notFound

      const standing =
        deps.standingOf === undefined
          ? null
          : await deps.standingOf(record.event.cleanupId, viewerUserId)
      const canManagePage = standing !== null && can(standing, "manage_page")
      const canViewPrivate = standing !== null && can(standing, "view_event_private")

      const publiclyReadable = record.page.status === "published" && record.page.flaggedAt === null
      if (!publiclyReadable && !canManagePage) throw notFound
      if (record.event.visibility === "private" && !canViewPrivate) throw notFound

      const at = now()
      const noindex =
        record.event.visibility !== "public" ||
        record.page.seo.noindex === true ||
        !publiclyReadable

      const sellable = record.ticketTypes.filter((type) => type.visibility !== "hidden")

      return {
        slug: record.page.slug ?? query.slug,
        status: record.page.status,
        visibility: record.event.visibility,
        noindex,
        theme: { accent: record.page.themeAccent },
        coverUrl: await coverUrlOf(record.page),
        logoUrl: null,
        blocks: await resolveBlockMedia(record.page.cleanupId, record.page.blocks),
        seo: { ...record.page.seo, noindex },
        event: {
          id: record.event.cleanupId,
          referenceCode: record.event.referenceCode,
          title: record.event.title,
          description: record.event.description,
          lat: record.event.lat,
          lng: record.event.lng,
          startsAt: record.event.scheduledAt.toISOString(),
          endsAt: record.event.endsAt === null ? null : record.event.endsAt.toISOString(),
          timezone: record.event.timezone,
          status: record.event.status,
          address: record.event.address,
          registrationOpensAt:
            record.event.registrationOpensAt === null
              ? null
              : record.event.registrationOpensAt.toISOString(),
          registrationClosesAt:
            record.event.registrationClosesAt === null
              ? null
              : record.event.registrationClosesAt.toISOString(),
        },
        ticketTypes: sellable.map((type) => toPublicTicketType(type, at)),
        questions: record.questions.map(toEventQuestionDTO),
        consentVersions: {
          termsVersion: currentVersion("terms"),
          disclosureVersion: currentVersion("privacy"),
        },
        waitlistEnabled: sellable.some((type) => type.waitlistEnabled),
        donationUrl: record.donationUrl,
        requiresTurnstile: true,
      }
    },
  }
}
