import {
  ANNOUNCEMENT_BROADCAST_KIND,
  ANNOUNCEMENT_CHANNELS,
  AppError,
  MAX_EVENT_ANNOUNCEMENTS_PER_DAY,
  announcementAudienceToSegment,
} from "@civfix/shared"
import type {
  AnnouncementAudience,
  AnnouncementDTO,
  BroadcastChannel,
  CreateEventAnnouncementRequest,
  ListEventAnnouncementsRequest,
  ListEventAnnouncementsResponse,
  PersonDTO,
} from "@civfix/shared"
import type { FastifyBaseLogger } from "fastify"
import { paginateKeyset, parseKeysetCursor } from "../../db/cursor-helpers.js"
import { clampPageLimit } from "../../lib/page-limit.js"
import type { AnnouncementCap, BroadcastRepository } from "./broadcast-repository.js"
import type { BroadcastRecord } from "./broadcast-types.js"
import { ANNOUNCEMENT_VISIBLE_STATUSES } from "./broadcast-types.js"
import { announcementPath, broadcastLinkWarnings } from "./broadcast-render.js"
import type { BroadcastConfig, BroadcastService } from "./broadcast-service.js"
import type { AnnouncementIdentityRepository } from "./announcement-repository.drizzle.js"

const ANNOUNCEMENT_DEFAULT_LIMIT = 20
const ANNOUNCEMENT_MAX_LIMIT = 50
const ANNOUNCEMENT_WINDOW_MS = 24 * 60 * 60 * 1000
const ANNOUNCEMENT_CTA_LABEL = "View announcement"

export interface AnnouncementServiceDeps {
  repo: BroadcastRepository
  identities: AnnouncementIdentityRepository
  broadcasts: BroadcastService
  config: Pick<BroadcastConfig, "chunkSize" | "linkAllowedHosts" | "webBaseUrl">
  logger?: Pick<FastifyBaseLogger, "warn">
  now?: () => Date
}

export interface AnnouncementProjection {
  host: boolean
}

export interface AnnouncementService {
  create(
    cleanupId: string,
    actorId: string,
    body: CreateEventAnnouncementRequest,
  ): Promise<AnnouncementDTO>
  list(
    cleanupId: string,
    query: ListEventAnnouncementsRequest,
    projection: AnnouncementProjection,
  ): Promise<ListEventAnnouncementsResponse>
  get(
    cleanupId: string,
    announcementId: string,
    projection: AnnouncementProjection,
  ): Promise<AnnouncementDTO>
}

function announcementRateLimited(): AppError {
  return AppError.rateLimited(
    "Announcement limit reached for today. Use the group chat for ongoing discussion.",
  )
}

export function announcementTitleOf(title: string | null | undefined, eventTitle: string): string {
  const trimmed = (title ?? "").trim()
  return trimmed.length > 0 ? trimmed : `Announcement · ${eventTitle}`
}

export function makeAnnouncementService(deps: AnnouncementServiceDeps): AnnouncementService {
  const now = deps.now ?? (() => new Date())
  const { repo, config } = deps

  function notFound(): AppError {
    return AppError.notFound("Announcement not found")
  }

  function audienceOf(record: BroadcastRecord): AnnouncementAudience | null {
    const segment = record.segment
    if (segment === null) return null
    if (
      segment.kind === "all_registered" ||
      segment.kind === "checked_in" ||
      segment.kind === "not_checked_in" ||
      segment.kind === "waitlist" ||
      segment.kind === "slots"
    ) {
      return segment
    }
    return null
  }

  function toDTO(
    record: BroadcastRecord,
    author: PersonDTO | null,
    authorOrg: AnnouncementDTO["authorOrg"],
    projection: AnnouncementProjection,
  ): AnnouncementDTO {
    const base: AnnouncementDTO = {
      id: record.id,
      cleanupId: record.cleanupId,
      status: record.status,
      author,
      authorOrg: authorOrg ?? null,
      title: record.subject,
      bodyMd: record.bodyMd ?? "",
      sentAt: (record.finishedAt ?? record.startedAt)?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
    }
    if (!projection.host) return base
    return {
      ...base,
      audience: audienceOf(record),
      recipientCount: record.recipientCount,
      sentCount: record.sentCount,
      failedCount: record.failedCount,
    }
  }

  async function hydrate(
    cleanupId: string,
    records: readonly BroadcastRecord[],
    projection: AnnouncementProjection,
  ): Promise<AnnouncementDTO[]> {
    if (records.length === 0) return []
    const [authors, organization] = await Promise.all([
      deps.identities.authorsFor(records.map((record) => record.createdBy)),
      deps.identities.organizationFor(cleanupId),
    ])
    return records.map((record) =>
      toDTO(
        record,
        record.createdBy === null ? null : (authors.get(record.createdBy) ?? null),
        organization,
        projection,
      ),
    )
  }

  function dailyCap(): AnnouncementCap {
    return {
      since: new Date(now().getTime() - ANNOUNCEMENT_WINDOW_MS),
      max: MAX_EVENT_ANNOUNCEMENTS_PER_DAY,
    }
  }

  function ctaFor(cleanupId: string, announcementId: string): string | null {
    const url = `${config.webBaseUrl}${announcementPath(cleanupId, announcementId)}`
    return broadcastLinkWarnings(url, config.linkAllowedHosts).length === 0 ? url : null
  }

  async function hydrateOne(
    cleanupId: string,
    record: BroadcastRecord,
    projection: AnnouncementProjection,
  ): Promise<AnnouncementDTO> {
    const [dto] = await hydrate(cleanupId, [record], projection)
    if (dto === undefined) throw notFound()
    return dto
  }

  return {
    async create(cleanupId, actorId, body) {
      await deps.broadcasts.assertComposeAllowed(cleanupId, actorId)

      const event = await repo.eventContext(cleanupId)
      if (event === null) throw AppError.notFound("Cleanup not found")

      const draft = await repo.createAnnouncementUnderCap(
        {
          cleanupId,
          createdBy: actorId,
          kind: ANNOUNCEMENT_BROADCAST_KIND,
          subject: announcementTitleOf(body.title, event.title),
          bodyMd: body.bodyMd,
          segment: announcementAudienceToSegment(body.audience),
          channels: [...ANNOUNCEMENT_CHANNELS] as BroadcastChannel[],
          status: "draft",
          chunkSize: config.chunkSize,
        },
        dailyCap(),
      )
      if (draft === null) throw announcementRateLimited()

      try {
        const cta = ctaFor(cleanupId, draft.id)
        if (cta !== null) {
          await repo.updateDraft(cleanupId, draft.id, {
            ctaLabel: ANNOUNCEMENT_CTA_LABEL,
            ctaUrl: cta,
          })
        }
        await deps.broadcasts.sendAnnouncement(cleanupId, actorId, draft.id)
      } catch (err) {
        await repo.deleteDraft(cleanupId, draft.id).catch((cleanupErr: unknown) => {
          deps.logger?.warn(
            { err: cleanupErr, cleanupId, announcementId: draft.id },
            "announcement: failed send left its draft behind; it counts toward today's cap",
          )
        })
        throw err
      }

      const sent = await repo.findForEvent(cleanupId, draft.id)
      if (sent === null) throw notFound()
      return hydrateOne(cleanupId, sent, { host: true })
    },

    async list(cleanupId, query, projection) {
      const limit = clampPageLimit(query.limit, ANNOUNCEMENT_DEFAULT_LIMIT, ANNOUNCEMENT_MAX_LIMIT)
      const rows = await repo.listAnnouncements({
        cleanupId,
        cursor: parseKeysetCursor(query.cursor, { direction: "desc" }),
        limit: limit + 1,
      })
      const { items, nextCursor } = paginateKeyset(rows, limit, (row) => ({
        atText: row.cursorAt,
        id: row.id,
      }))
      return { items: await hydrate(cleanupId, items, projection), nextCursor }
    },

    async get(cleanupId, announcementId, projection) {
      const record = await repo.findForEvent(cleanupId, announcementId)
      if (record === null || record.kind !== ANNOUNCEMENT_BROADCAST_KIND) throw notFound()
      if (!projection.host && !ANNOUNCEMENT_VISIBLE_STATUSES.includes(record.status)) {
        throw notFound()
      }
      return hydrateOne(cleanupId, record, projection)
    },
  }
}
