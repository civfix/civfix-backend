/**
 * Admin moderation service (Phase 2): the operator moderation queue.
 *
 * The queue is fed by `moderation_items` (one row per held media / coordinated-report cluster / appeal
 * / gps / duplicate). The operator works the OPEN items and applies an action that both transitions the
 * item's status AND applies the underlying effect on its subject:
 *   - approve -> publish the held report (reports.status held -> published) + item status 'approved';
 *   - remove  -> reject the report (reports.status -> rejected, soft-delete) + item status 'removed';
 *   - hold    -> extend the hold (item stays held, NOT open) so it leaves the open queue;
 *   - appeal  -> decide a chat suspension appeal (uphold|overturn) + item status 'approved'.
 * Items must CLEAR from the queue on any action (status <> 'open'), per the civfixplan done-gate. Every
 * action is audited via writeAudit (moderation.approved|removed|held|appeal_decided).
 *
 * REPOSITORY SEAM: every read/write goes through ModerationRepository (Drizzle impl in
 * moderation-repository.drizzle.ts; an in-memory impl in moderation-repository.memory.ts for the offline
 * unit tests), mirroring the Phase 1 report-service/report-repository split so the service is testable
 * with no database and no Docker. The list/detail PROJECTIONS (relative-age labels, the signals/user/
 * similar shaping) live here and are pure + clock-injected.
 *
 * PRODUCER: `createItem` is the single entrypoint the producers use to enqueue a moderation item (the
 * anon hold-then-publish path, the media-worker hold path, and abuse detection). The backfill
 * (backfillFromHeldReports) creates items for every currently-held report that does not already have an
 * open item, so the queue is populated from the existing hold backlog. See moderation-repository.drizzle.
 */

import { AppError, relativeAgo } from "@civfix/shared"
import type {
  ModerationItemDTO,
  ModerationKind,
  ModerationListQuery,
  ModerationListResponse,
  ModerationMedia,
  ModerationSignal,
  ModerationSimilar,
  ModerationUser,
  Priority,
  ReportCategory,
} from "@civfix/shared"
import { clampLimit } from "./pagination.js"

// ---------------------------------------------------------------------------
// Repository seam (structural records; faked in tests)
// ---------------------------------------------------------------------------

/** The OPEN-queue facet (mirrors the shared ModerationListQuery filter). */
export type ModerationFilter = "all" | ModerationKind | "high"

/** Normalized list arguments the repo consumes (search + facet + page window). */
export interface ListModerationArgs {
  q: string | null
  filter: ModerationFilter
  cursor: string | null
  limit: number
}

/** The user-context snapshot carried on an item's `meta` jsonb (set by the producer). */
export interface ModerationUserSnapshot {
  handle: string
  name: string
  joined: string
  priorReports: number
  priorRemovals: number
  strikes: number
  device: string
}

/** A held media reference shown in the detail (the actual asset, by kind). */
export interface ModerationMediaRecord {
  id: string
  kind: "image" | "video"
  url: string
  thumbUrl: string | null
}

/**
 * A moderation_items row projected into the service's record shape. `signals` / `similar` are the parsed
 * jsonb arrays; `user` is the parsed meta snapshot (null when the producer did not record one, in which
 * case the service substitutes a neutral default so the strict DTO still validates). `media` is the held
 * media for the subject (joined from media_assets for report subjects).
 */
export interface ModerationItemRecord {
  id: string
  kind: ModerationKind
  subjectType: "report" | "user" | "chat"
  subjectId: string
  flag: string | null
  reason: string | null
  category: ReportCategory | null
  place: string | null
  priority: Priority
  autoAction: string | null
  reporter: string | null
  desc: string | null
  status: "open" | "approved" | "removed" | "held"
  signals: ModerationSignal[]
  similar: ModerationSimilar[]
  user: ModerationUserSnapshot | null
  media: ModerationMediaRecord[]
  createdAt: Date
}

/** What a producer supplies to enqueue a moderation item. Defaults fill the optional shaping fields. */
export interface CreateModerationItemInput {
  kind: ModerationKind
  subjectType: "report" | "user" | "chat"
  subjectId: string
  flag?: string | null
  reason?: string | null
  category?: ReportCategory | null
  place?: string | null
  priority?: Priority
  autoAction?: string | null
  reporter?: string | null
  desc?: string | null
  signals?: ModerationSignal[]
  similar?: ModerationSimilar[]
  user?: ModerationUserSnapshot | null
  /** When true, do NOT create a duplicate if an OPEN item already exists for (subjectType, subjectId). */
  dedupeOpen?: boolean
}

/**
 * Persistence seam for the moderation domain. The Drizzle impl runs raw SQL (joins media_assets +
 * reports + abuse_flags for the detail); the offline tests pass an in-memory impl. Action methods return
 * a small result so the service can build the audit + decide the not-found 404.
 */
export interface ModerationRepository {
  /** Page the OPEN items applying the search + kind/priority facet, newest-first keyset paged. */
  listOpen(
    args: ListModerationArgs,
  ): Promise<{ records: ModerationItemRecord[]; nextCursor: string | null }>
  /** Load one item's full detail by id (any status), or null when it does not exist. */
  getItem(id: string): Promise<ModerationItemRecord | null>
  /**
   * Approve an OPEN item: set status 'approved' (+ resolved_at/by) AND publish the held report subject
   * (reports.status held -> published, published_at = now, report_timeline 'published'). Returns the
   * resolved item record, or null when the item does not exist / is not open.
   */
  approve(
    id: string,
    input: { actorId: string | null; note: string | null },
  ): Promise<ModerationItemRecord | null>
  /**
   * Remove an OPEN item: set status 'removed' (+ resolved_at/by) AND reject the report subject
   * (reports.status -> rejected, deleted_at = now, report_timeline 'rejected'). Returns the resolved
   * item record, or null when the item does not exist / is not open.
   */
  remove(
    id: string,
    input: { actorId: string | null; reason: string | null },
  ): Promise<ModerationItemRecord | null>
  /**
   * Extend the hold on an OPEN item: set status 'held' (+ resolved_at/by) so it leaves the open queue
   * but is NOT published or rejected (a later sweep / re-review can re-open). Returns the resolved item
   * record, or null when the item does not exist / is not open.
   */
  hold(
    id: string,
    input: { actorId: string | null; note: string | null },
  ): Promise<ModerationItemRecord | null>
  /**
   * Decide an appeal item (kind 'appeal', subject_type 'chat'): uphold keeps the suspension; overturn
   * lifts it (clears the suspending abuse_flag for the chat subject). Either way the item leaves the
   * queue with status 'approved' (resolved). Returns the resolved item record, or null when the item
   * does not exist / is not open / is not an appeal.
   */
  decideAppeal(
    id: string,
    input: { decision: "uphold" | "overturn"; actorId: string | null; note: string | null },
  ): Promise<ModerationItemRecord | null>
  /** Enqueue a moderation item (the producer entrypoint). Returns the new item id, or null when deduped. */
  createItem(input: CreateModerationItemInput): Promise<string | null>
  /**
   * Backfill: create one moderation item per currently-held report (reports.status = 'held', not
   * deleted) that does not already have an OPEN item. Returns the number of items created.
   */
  backfillFromHeldReports(): Promise<number>
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB, no IO)
// ---------------------------------------------------------------------------

/** A neutral user snapshot used when an item has no recorded meta (keeps the strict DTO valid). */
export const NEUTRAL_USER_SNAPSHOT: ModerationUserSnapshot = {
  handle: "",
  name: "Unknown",
  joined: "",
  priorReports: 0,
  priorRemovals: 0,
  strikes: 0,
  device: "",
}

/** Project the user snapshot (or the neutral default) into the strict ModerationUser DTO. */
function toUserDTO(snapshot: ModerationUserSnapshot | null): ModerationUser {
  const s = snapshot ?? NEUTRAL_USER_SNAPSHOT
  return {
    handle: s.handle,
    name: s.name,
    joined: s.joined,
    priorReports: s.priorReports,
    priorRemovals: s.priorRemovals,
    strikes: s.strikes,
    device: s.device,
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ModerationServiceDeps {
  repo: ModerationRepository
  /** Injectable clock (defaults to Date.now) so the relative-age labels are deterministic. */
  now?: () => Date
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
  /** Producer entrypoint: enqueue a moderation item. Returns the new id, or null when deduped. */
  createItem(input: CreateModerationItemInput): Promise<string | null>
  /** Backfill items from the currently-held reports. Returns the count created. */
  backfill(): Promise<number>
}

export function makeModerationService(deps: ModerationServiceDeps): ModerationService {
  const now = deps.now ?? (() => new Date())

  /** Project a record into the queue list DTO (the row shape). */
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
    }
  }

  /** Project a record into the full detail DTO (the list shape + the detail extras). */
  function toDetailDTO(record: ModerationItemRecord, ref: Date): ModerationItemDTO {
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
    const media: ModerationMedia[] = record.media.map((m) => ({
      id: m.id,
      kind: m.kind,
      url: m.url,
      thumbUrl: m.thumbUrl,
    }))
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
        filter: (query.filter ?? "all") as ModerationFilter,
        cursor: query.cursor ?? null,
        limit: clampLimit(query.limit),
      }
      const { records, nextCursor } = await deps.repo.listOpen(args)
      return { items: records.map((r) => toListDTO(r, ref)), nextCursor }
    },

    async getItem(id: string): Promise<ModerationItemDTO> {
      const ref = now()
      const record = await deps.repo.getItem(id)
      if (!record) throw AppError.notFound("Moderation item not found")
      return toDetailDTO(record, ref)
    },

    async approve(
      id: string,
      input: { actorId: string | null; note: string | null },
    ): Promise<void> {
      const result = await deps.repo.approve(id, input)
      if (!result) throw AppError.notFound("Moderation item not found")
    },

    async remove(
      id: string,
      input: { actorId: string | null; reason: string | null },
    ): Promise<void> {
      const result = await deps.repo.remove(id, input)
      if (!result) throw AppError.notFound("Moderation item not found")
    },

    async hold(id: string, input: { actorId: string | null; note: string | null }): Promise<void> {
      const result = await deps.repo.hold(id, input)
      if (!result) throw AppError.notFound("Moderation item not found")
    },

    async appeal(
      id: string,
      input: { decision: "uphold" | "overturn"; actorId: string | null; note: string | null },
    ): Promise<void> {
      const result = await deps.repo.decideAppeal(id, input)
      if (!result) throw AppError.notFound("Moderation item not found")
    },

    async createItem(input: CreateModerationItemInput): Promise<string | null> {
      return deps.repo.createItem(input)
    },

    async backfill(): Promise<number> {
      return deps.repo.backfillFromHeldReports()
    },
  }
}
