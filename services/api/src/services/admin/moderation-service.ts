import { AppError, relativeAgo } from "@civfix/shared"
import type {
  ModerationItemDTO,
  ModerationDestinationKind,
  ModerationKind,
  ModerationSubjectType,
  ModerationListQuery,
  ModerationListResponse,
  ModerationMedia,
  ModerationSignal,
  ModerationSimilar,
  ModerationUser,
  Priority,
  ReportCategory,
  UserStatus,
} from "@civfix/shared"
import { clampLimit } from "./pagination.js"
import { timelineKindForStatus } from "./admin-report-status.js"
import { mapWithLimit, PRESIGN_CONCURRENCY, type PresignMedia } from "../media-presign.js"
import type { ReportChatSystemEmitter } from "../report-timeline-event.js"
import type { MessageUpdateAnnouncer } from "./admin-report-chat-service.js"

export type ModerationFilter = "all" | ModerationKind | "high"

/** Shared by the service's chat mirror and the repository's report_timeline row, which must agree. */
export const MODERATION_APPROVED_NOTE = "Approved in moderation"
export const MODERATION_REMOVED_NOTE = "Removed in moderation"

const MODERATION_ITEM_NOT_FOUND = "Moderation item not found"

export interface ListModerationArgs {
  q: string | null
  filter: ModerationFilter
  cursor: string | null
  limit: number
}

export interface ModerationUserSnapshot {
  id: string | null
  handle: string
  name: string
  joined: string
  priorReports: number
  priorRemovals: number
  strikes: number
  device: string
}

export interface ModerationMediaRecord {
  id: string
  kind: "image" | "video"
  r2Key: string
  thumbKey: string | null
}

export interface ModerationItemRecord {
  id: string
  kind: ModerationKind
  subjectType: ModerationSubjectType
  subjectId: string
  destinationKind: ModerationDestinationKind | null
  destinationId: string | null
  flag: string | null
  reason: string | null
  category: ReportCategory | null
  place: string | null
  priority: Priority
  autoAction: string | null
  reporter: string | null
  reporterId: string | null
  desc: string | null
  status: "open" | "approved" | "removed" | "held"
  signals: ModerationSignal[]
  similar: ModerationSimilar[]
  user: ModerationUserSnapshot | null
  media: ModerationMediaRecord[]
  createdAt: Date
  reportTimelineStatus?: "published" | "rejected"
  restoredUserId?: string
  suspendedUserId?: string
}

export interface CreateModerationItemInput {
  kind: ModerationKind
  subjectType: ModerationSubjectType
  subjectId: string
  flag?: string | null
  reason?: string | null
  category?: ReportCategory | null
  place?: string | null
  priority?: Priority
  autoAction?: string | null
  reporter?: string | null
  reporterUserId?: string | null
  desc?: string | null
  signals?: ModerationSignal[]
  similar?: ModerationSimilar[]
  user?: ModerationUserSnapshot | null
  dedupeOpen?: boolean
}

export interface ModerationRepository {
  listOpen(
    args: ListModerationArgs,
  ): Promise<{ records: ModerationItemRecord[]; nextCursor: string | null }>
  getItem(id: string): Promise<ModerationItemRecord | null>
  approve(
    id: string,
    input: { actorId: string | null; note: string | null },
  ): Promise<ModerationItemRecord | null>
  remove(
    id: string,
    input: { actorId: string | null; reason: string | null },
  ): Promise<ModerationItemRecord | null>
  hold(
    id: string,
    input: { actorId: string | null; note: string | null },
  ): Promise<ModerationItemRecord | null>
  decideAppeal(
    id: string,
    input: { decision: "uphold" | "overturn"; actorId: string | null; note: string | null },
  ): Promise<ModerationItemRecord | null>
  createItem(input: CreateModerationItemInput): Promise<string | null>
  backfillFromHeldReports(): Promise<number>
}

const NEUTRAL_USER_SNAPSHOT: ModerationUserSnapshot = {
  id: null,
  handle: "",
  name: "Unknown",
  joined: "",
  priorReports: 0,
  priorRemovals: 0,
  strikes: 0,
  device: "",
}

function toUserDTO(snapshot: ModerationUserSnapshot | null): ModerationUser {
  const s = snapshot ?? NEUTRAL_USER_SNAPSHOT
  return {
    id: s.id,
    handle: s.handle,
    name: s.name,
    joined: s.joined,
    priorReports: s.priorReports,
    priorRemovals: s.priorRemovals,
    strikes: s.strikes,
    device: s.device,
  }
}

export interface ModerationSessionControl {
  applyStatus(userId: string, status: UserStatus): Promise<number>
}

export interface ModerationServiceDeps {
  repo: ModerationRepository
  presignMedia?: PresignMedia
  now?: () => Date
  reportChatEmitter?: ReportChatSystemEmitter
  sessions?: ModerationSessionControl
  announceMessageUpdate?: MessageUpdateAnnouncer
}

export function isMessageSubject(subjectType: ModerationSubjectType): boolean {
  return subjectType === "chat" || subjectType === "message"
}

export function isUserSubject(subjectType: ModerationSubjectType): boolean {
  return subjectType === "user" || subjectType === "profile"
}

export interface ModerationService {
  list(query: ModerationListQuery): Promise<ModerationListResponse>
  getItem(id: string): Promise<ModerationItemDTO>
  approve(id: string, input: { actorId: string | null; note: string | null }): Promise<void>
  remove(id: string, input: { actorId: string | null; reason: string | null }): Promise<void>
  hold(id: string, input: { actorId: string | null; note: string | null }): Promise<void>
  appeal(
    id: string,
    input: { decision: "uphold" | "overturn"; actorId: string | null; note: string | null },
  ): Promise<void>
  createItem(input: CreateModerationItemInput): Promise<string | null>
  backfill(): Promise<number>
}

export function makeModerationService(deps: ModerationServiceDeps): ModerationService {
  const now = deps.now ?? (() => new Date())
  const presignMedia: PresignMedia =
    deps.presignMedia ??
    (async (r2Key: string, thumbKey: string | null) =>
      thumbKey === null ? { url: r2Key } : { url: r2Key, thumbUrl: thumbKey })

  function toListDTO(record: ModerationItemRecord, ref: Date) {
    return {
      id: record.id,
      flag: record.flag ?? "",
      reporter: record.reporter ?? "",
      category: record.category,
      reason: record.reason ?? "",
      age: relativeAgo(record.createdAt, ref),
      priority: record.priority,
      kind: record.kind,
      subjectType: record.subjectType,
      subjectId: record.subjectId,
      destinationKind: record.destinationKind,
      destinationId: record.destinationId,
      reporterId: record.reporterId,
    }
  }

  async function toDetailDTO(record: ModerationItemRecord, ref: Date): Promise<ModerationItemDTO> {
    const signals: ModerationSignal[] = record.signals.map((s) => ({
      label: s.label,
      val: s.val,
      tone: s.tone,
    }))
    const similar: ModerationSimilar[] = record.similar.map((s) => ({
      id: s.id,
      note: s.note,
      when: s.when,
    }))
    const media: ModerationMedia[] = await mapWithLimit(
      record.media,
      PRESIGN_CONCURRENCY,
      async (m) => {
        const { url, thumbUrl } = await presignMedia(m.r2Key, m.thumbKey)
        return { id: m.id, kind: m.kind, url, thumbUrl: thumbUrl ?? null }
      },
    )
    return {
      ...toListDTO(record, ref),
      desc: record.desc ?? "",
      autoAction: record.autoAction,
      place: record.place,
      signals,
      user: toUserDTO(record.user),
      similar,
      media,
    }
  }

  return {
    async list(query: ModerationListQuery): Promise<ModerationListResponse> {
      const ref = now()
      const args: ListModerationArgs = {
        q: query.q && query.q.trim() !== "" ? query.q.trim() : null,
        filter: query.filter ?? "all",
        cursor: query.cursor ?? null,
        limit: clampLimit(query.limit),
      }
      const { records, nextCursor } = await deps.repo.listOpen(args)
      return { items: records.map((r) => toListDTO(r, ref)), nextCursor }
    },

    async getItem(id: string): Promise<ModerationItemDTO> {
      const ref = now()
      const record = await deps.repo.getItem(id)
      if (!record) throw AppError.notFound(MODERATION_ITEM_NOT_FOUND)
      return toDetailDTO(record, ref)
    },

    async approve(
      id: string,
      input: { actorId: string | null; note: string | null },
    ): Promise<void> {
      const result = await deps.repo.approve(id, input)
      if (!result) throw AppError.notFound(MODERATION_ITEM_NOT_FOUND)
      if (deps.reportChatEmitter && result.reportTimelineStatus === "published") {
        await deps.reportChatEmitter.emit({
          reportId: result.subjectId,
          status: "published",
          kind: timelineKindForStatus("published"),
          note: MODERATION_APPROVED_NOTE,
        })
      }
    },

    async remove(
      id: string,
      input: { actorId: string | null; reason: string | null },
    ): Promise<void> {
      const result = await deps.repo.remove(id, input)
      if (!result) throw AppError.notFound(MODERATION_ITEM_NOT_FOUND)
      if (isMessageSubject(result.subjectType)) {
        await deps.announceMessageUpdate?.(result.subjectId)
      }
      if (result.suspendedUserId && deps.sessions) {
        await deps.sessions.applyStatus(result.suspendedUserId, "suspended")
      }
      if (deps.reportChatEmitter && result.reportTimelineStatus === "rejected") {
        await deps.reportChatEmitter.emit({
          reportId: result.subjectId,
          status: "rejected",
          kind: timelineKindForStatus("rejected"),
          note: input.reason ?? MODERATION_REMOVED_NOTE,
        })
      }
    },

    async hold(id: string, input: { actorId: string | null; note: string | null }): Promise<void> {
      const result = await deps.repo.hold(id, input)
      if (!result) throw AppError.notFound(MODERATION_ITEM_NOT_FOUND)
    },

    async appeal(
      id: string,
      input: { decision: "uphold" | "overturn"; actorId: string | null; note: string | null },
    ): Promise<void> {
      const result = await deps.repo.decideAppeal(id, input)
      if (!result) throw AppError.notFound(MODERATION_ITEM_NOT_FOUND)
      if (input.decision === "overturn" && isMessageSubject(result.subjectType)) {
        await deps.announceMessageUpdate?.(result.subjectId)
      }
      if (result.restoredUserId && deps.sessions) {
        await deps.sessions.applyStatus(result.restoredUserId, "active")
      }
    },

    async createItem(input: CreateModerationItemInput): Promise<string | null> {
      return deps.repo.createItem(input)
    },

    async backfill(): Promise<number> {
      return deps.repo.backfillFromHeldReports()
    },
  }
}
