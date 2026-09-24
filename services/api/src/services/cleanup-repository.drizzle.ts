
import { randomUUID } from "node:crypto"
import {
  AppError,
  MAX_EVENT_QUESTIONS,
  MAX_LINKED_REPORTS,
  MAX_TICKET_TYPES_PER_EVENT,
} from "@civfix/shared"
import type postgres from "postgres"
import type { Queryable, Sql } from "../db/client.js"
import {
  encodeNearCursor,
  encodeTimeCursor,
  pageWith,
  parseNearCursor,
  parseTimeCursor,
} from "../db/cursor-helpers.js"
import { allocateEventReferenceCode } from "../db/reference-code.js"
import { firstReadyStillLateral, publicReportFilter } from "./report-sql.js"
import { hostStandingOf, hostStandingsOf, orgStandingOf } from "./host/host-standing.js"
import { NO_HOST_STANDING } from "@civfix/shared/host"
import { servableMediaFilter, servedKeyExpr } from "./media-served-key.js"
import { MEDIA_CLAIM_WINDOW_SEC } from "./host/event-media.js"
import { mediaBoundElsewhere, mediaBoundToCleanup } from "./media-bindings.js"
import { isUniqueViolationOn } from "./host/registration-sql.js"
import { deterministicUuid } from "./deterministic-uuid.js"
import type {
  AttendeeView,
  CancelCleanupOutcome,
  ClaimSlotOutcome,
  CleanupOrganizationView,
  CleanupIdempotency,
  CleanupRecord,
  CleanupRepository,
  CreateCleanupOutcome,
  EventHostWrite,
  CreateCleanupTxArgs,
  DesiredSlot,
  DuplicateSource,
  EventSlotView,
  JoinCleanupOutcome,
  LinkedEventView,
  LinkedReportView,
  ListAttendeesArgs,
  LeaveCleanupOutcome,
  ListCleanupsFilters,
  NearPoint,
  OrganizationEventsFilters,
  OrganizationEventsHost,
  RemoveMemberOutcome,
  SignupSeat,
  SlotReconcileResult,
  UpdateCleanupPatch,
} from "./cleanup-repository.types.js"
import { eventWindowOfRow, hasEventEnded } from "./cleanup-rules.js"
import { blockedPairExpr, hiddenIdentity } from "./hidden-identity.js"
import {
  buildBboxFilter,
  buildMembershipFilter,
  buildWhenFilter,
  buildVisibilityFilter,
  cleanupColumns,
  cleanupStatusExpr,
  eventHostJoins,
  goingJoin,
  goingScalar,
  toRecord,
  type AttendeeRowSelect,
  type CleanupRowSelect,
} from "./cleanup-sql.js"
import type {
  CleanupMemberRole,
  CleanupStatus,
  EventKind,
  EventVisibility,
  OrganizationMemberRole,
  OrgVerificationKind,
  OrgVerificationStatus,
  ReportCategory,
  ReportStatus,
  ReportType,
} from "@civfix/shared"
import type { HostStanding } from "@civfix/shared/host"
import { touchUserActivity } from "../db/sql/user-activity.js"

const PG_UNIQUE_VIOLATION = "23505"

export const LINKED_EVENTS_PER_REPORT_CAP = 20
export const MAX_EVENTS_PER_REPORT = 50

const SLOT_TITLE_INDEX = "cleanup_slots_cleanup_title_window_uidx"

export interface SlotIdentity {
  title: string
  startsAt: Date | null
  endsAt: Date | null
}

export function slotWindowKey(slot: Pick<SlotIdentity, "startsAt" | "endsAt">): string {
  return `${slot.startsAt?.getTime() ?? ""}|${slot.endsAt?.getTime() ?? ""}`
}

export function slotIdentityKey(slot: SlotIdentity): string {
  return `${slot.title.trim().toLowerCase()}|${slotWindowKey(slot)}`
}

function isSlotTitleConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const e = err as { code?: unknown; constraint_name?: unknown; detail?: unknown }
  if (e.code !== PG_UNIQUE_VIOLATION) return false
  const constraint = typeof e.constraint_name === "string" ? e.constraint_name : ""
  const detail = typeof e.detail === "string" ? e.detail : ""
  return constraint === SLOT_TITLE_INDEX || detail.includes("lower(title)")
}

async function claimEventMediaInTx(
  tx: Queryable,
  cleanupId: string,
  host: EventHostWrite,
): Promise<void> {
  const cover = host.coverMediaId ?? null
  const gallery = host.galleryMediaIds ?? []
  const wanted = [...new Set([...(cover === null ? [] : [cover]), ...gallery])]
  if (wanted.length === 0) return
  const claimed = await tx<{ id: string }[]>`
    UPDATE media_assets
    SET purpose = CASE WHEN id = ${cover} THEN 'event_cover' ELSE 'event_gallery' END
    WHERE id = ANY(${wanted}::uuid[])
      AND purpose <> 'verification'
      AND report_id IS NULL AND post_id IS NULL AND chat_message_id IS NULL
      AND (status = 'ready' OR (status = 'validating' AND finalized_at IS NOT NULL))
      AND NOT (${mediaBoundElsewhere(tx, cleanupId)})
      AND (
        (${mediaBoundToCleanup(tx, cleanupId)})
        OR media_assets.created_at > now() - make_interval(secs => ${MEDIA_CLAIM_WINDOW_SEC})
      )
    RETURNING id
  `
  if (claimed.length !== wanted.length) {
    throw AppError.validation({ coverMediaId: "One or more images are unavailable." })
  }
}

const PAGE_BLOCK_MEDIA_KEYS = new Set(["mediaId", "avatarMediaId", "logoMediaId"])

export function stripPageBlockMedia(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPageBlockMedia)
  if (typeof value !== "object" || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (PAGE_BLOCK_MEDIA_KEYS.has(key)) continue
    out[key] = stripPageBlockMedia(entry)
  }
  return out
}

async function copyTicketTypesInTx(
  tx: Queryable,
  cleanupId: string,
  source: DuplicateSource,
): Promise<{ oldIds: string[]; newIds: string[] }> {
  if (!source.ticketTypes) return { oldIds: [], newIds: [] }
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM cleanup_ticket_types
    WHERE cleanup_id = ${source.cleanupId}
    ORDER BY sort_order, id
    LIMIT ${MAX_TICKET_TYPES_PER_EVENT}
  `
  const oldIds = rows.map((row) => row.id)
  if (oldIds.length === 0) return { oldIds, newIds: [] }
  const newIds = oldIds.map(() => randomUUID())
  await tx`
    INSERT INTO cleanup_ticket_types (
      id, cleanup_id, name, description, capacity, reserved_seats,
      sales_opens_at, sales_closes_at, visibility, access_code_hash,
      max_party_size, sort_order, waitlist_enabled
    )
    SELECT m.new_id, ${cleanupId}, t.name, t.description, t.capacity, 0,
           CASE WHEN t.sales_opens_at > now() THEN t.sales_opens_at ELSE NULL END,
           CASE WHEN t.sales_closes_at > now() THEN t.sales_closes_at ELSE NULL END,
           t.visibility, t.access_code_hash, t.max_party_size, t.sort_order, t.waitlist_enabled
    FROM cleanup_ticket_types t
    JOIN unnest(${oldIds}::uuid[], ${newIds}::uuid[]) AS m(old_id, new_id) ON m.old_id = t.id
  `
  return { oldIds, newIds }
}

async function copyQuestionsInTx(
  tx: Queryable,
  cleanupId: string,
  source: DuplicateSource,
  types: { oldIds: string[]; newIds: string[] },
): Promise<void> {
  if (!source.questions) return
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM cleanup_questions
    WHERE cleanup_id = ${source.cleanupId} AND archived_at IS NULL
    ORDER BY sort_order, id
    LIMIT ${MAX_EVENT_QUESTIONS}
  `
  const oldIds = rows.map((row) => row.id)
  if (oldIds.length === 0) return
  const newIds = oldIds.map(() => randomUUID())
  await tx`
    INSERT INTO cleanup_questions (
      id, cleanup_id, ticket_type_id, kind, prompt, help_text, required,
      options, max_selections, consent_text, show_if, sort_order
    )
    SELECT qm.new_id, ${cleanupId}, tm.new_id, q.kind, q.prompt, q.help_text, q.required,
           q.options, q.max_selections, q.consent_text,
           CASE
             WHEN q.show_if IS NULL OR sm.new_id IS NULL THEN NULL
             ELSE jsonb_set(q.show_if, '{questionId}', to_jsonb(sm.new_id::text))
           END,
           q.sort_order
    FROM cleanup_questions q
    JOIN unnest(${oldIds}::uuid[], ${newIds}::uuid[]) AS qm(old_id, new_id) ON qm.old_id = q.id
    LEFT JOIN unnest(${types.oldIds}::uuid[], ${types.newIds}::uuid[]) AS tm(old_id, new_id)
      ON tm.old_id = q.ticket_type_id
    LEFT JOIN unnest(${oldIds}::uuid[], ${newIds}::uuid[]) AS sm(old_id, new_id)
      ON sm.old_id::text = q.show_if ->> 'questionId'
  `
}

async function copyPageInTx(
  tx: Queryable,
  cleanupId: string,
  source: DuplicateSource,
): Promise<void> {
  if (!source.page) return
  const rows = await tx<{ theme_accent: string; blocks: unknown; seo: unknown }[]>`
    SELECT theme_accent, blocks, seo FROM cleanup_pages
    WHERE cleanup_id = ${source.cleanupId}
    LIMIT 1
  `
  const page = rows[0]
  if (page === undefined) return
  const blocks = stripPageBlockMedia(page.blocks)
  await tx`
    INSERT INTO cleanup_pages (cleanup_id, status, theme_accent, blocks, seo)
    VALUES (
      ${cleanupId},
      'draft',
      ${page.theme_accent},
      ${tx.json(blocks as Parameters<typeof tx.json>[0])},
      ${tx.json(page.seo as Parameters<typeof tx.json>[0])}
    )
  `
}

async function copyEventExtrasInTx(
  tx: Queryable,
  cleanupId: string,
  source: DuplicateSource,
): Promise<void> {
  const types = await copyTicketTypesInTx(tx, cleanupId, source)
  await copyQuestionsInTx(tx, cleanupId, source, types)
  await copyPageInTx(tx, cleanupId, source)
}

async function privateEventBlocksJoin(
  tx: Queryable,
  cleanupId: string,
  visibility: EventVisibility,
  organizationId: string | null,
  userId: string,
): Promise<boolean> {
  if (visibility !== "private") return false
  const standing = await tx<{ one: number }[]>`
    SELECT 1 AS one
    WHERE EXISTS (
      SELECT 1 FROM cleanup_members m
      WHERE m.cleanup_id = ${cleanupId} AND m.user_id = ${userId}
    ) OR EXISTS (
      SELECT 1 FROM organization_members om
      JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL
      WHERE om.organization_id = ${organizationId} AND om.user_id = ${userId}
    )
    LIMIT 1
  `
  return standing.length === 0
}

function hostSetFragments(sql: Sql, patch: EventHostWrite): postgres.Fragment[] {
  const sets: postgres.Fragment[] = []
  if (patch.endsAt !== undefined) sets.push(sql`ends_at = ${patch.endsAt}`)
  if (patch.timezone !== undefined) sets.push(sql`timezone = ${patch.timezone}`)
  if (patch.visibility !== undefined) sets.push(sql`visibility = ${patch.visibility}`)
  if (patch.coverMediaId !== undefined) sets.push(sql`cover_media_id = ${patch.coverMediaId}`)
  if (patch.galleryMediaIds !== undefined) {
    sets.push(sql`gallery_media_ids = ${patch.galleryMediaIds as unknown as string[]}`)
  }
  if (patch.donationUrl !== undefined) sets.push(sql`donation_url = ${patch.donationUrl}`)
  if (patch.pageSlug !== undefined) sets.push(sql`page_slug = ${patch.pageSlug}`)
  if (patch.registrationOpensAt !== undefined) {
    sets.push(sql`registration_opens_at = ${patch.registrationOpensAt}`)
  }
  if (patch.registrationClosesAt !== undefined) {
    sets.push(sql`registration_closes_at = ${patch.registrationClosesAt}`)
  }
  if (patch.organizationId !== undefined) {
    sets.push(sql`organization_id = ${patch.organizationId}`)
  }
  if (patch.reminderOffsetsMin !== undefined) {
    sets.push(
      sql`reminder_offsets_min = ${patch.reminderOffsetsMin as unknown as number[] | null}`,
    )
  }
  if (patch.hostReplyTo !== undefined) {
    sets.push(sql`host_reply_to = ${patch.hostReplyTo}, host_reply_to_verified_at = NULL`)
  }
  return sets
}

export function makeDrizzleCleanupRepository(sql: Sql): CleanupRepository {
  async function readById(
    tag: Queryable,
    id: string,
    near: NearPoint | null,
  ): Promise<CleanupRecord | null> {
    const rows = await tag<CleanupRowSelect[]>`
      SELECT ${cleanupColumns(tag, near)}
      FROM cleanups c
      JOIN users u ON u.id = c.organizer_user_id
      ${goingJoin(tag)}
      ${eventHostJoins(tag)}
      WHERE c.id = ${id}
      LIMIT 1
    `
    return rows[0] ? toRecord(rows[0]) : null
  }

  function idempotencyRowKey(idem: CleanupIdempotency): string {
    return deterministicUuid([idem.scope, idem.userOrAnon ?? "", idem.key])
  }

  async function readIdempotentCleanupId(idem: CleanupIdempotency): Promise<string | null> {
    const rows = await sql<{ response_snapshot: { cleanupId?: string } }[]>`
      SELECT response_snapshot
      FROM idempotency_keys
      WHERE key = ${idempotencyRowKey(idem)}
        AND scope = ${idem.scope}
        AND user_or_anon IS NOT DISTINCT FROM ${idem.userOrAnon}
      LIMIT 1
    `
    return rows[0]?.response_snapshot?.cleanupId ?? null
  }

  return {
    async createCleanupTx(args: CreateCleanupTxArgs): Promise<CreateCleanupOutcome> {
      const idem = args.idempotency
      try {
        const record = await sql.begin(async (tx) => {
          const referenceCode = await allocateEventReferenceCode(tx, args.jurCode)

          await tx`
            INSERT INTO cleanups (
              id, organizer_user_id, type, event_kind, title, description, geom, scheduled_at,
              status, bring, address, address_source, jurisdiction_geoid, reference_code,
              ends_at, timezone, visibility, cover_media_id, gallery_media_ids, donation_url,
              page_slug, registration_opens_at, registration_closes_at, organization_id,
              reminder_offsets_min, host_reply_to
            ) VALUES (
              ${args.cleanupId},
              ${args.organizerUserId},
              ${args.type},
              ${args.eventKind},
              ${args.title},
              ${args.description},
              ST_SetSRID(ST_MakePoint(${args.lng}, ${args.lat}), 4326),
              ${args.scheduledAt},
              ${args.status},
              ${args.bring as unknown as string[] | null},
              ${args.address},
              ${args.addressSource},
              ${args.jurisdictionGeoid},
              ${referenceCode},
              ${args.host.endsAt},
              ${args.host.timezone ?? null},
              ${args.host.visibility ?? "public"},
              ${args.host.coverMediaId ?? null},
              ${(args.host.galleryMediaIds ?? []) as unknown as string[]},
              ${args.host.donationUrl ?? null},
              ${args.host.pageSlug ?? null},
              ${args.host.registrationOpensAt ?? null},
              ${args.host.registrationClosesAt ?? null},
              ${args.host.organizationId ?? null},
              ${(args.host.reminderOffsetsMin ?? null) as unknown as number[] | null},
              ${args.host.hostReplyTo ?? null}
            )
          `
          await tx`
            INSERT INTO cleanup_members (cleanup_id, user_id, role)
            VALUES (${args.cleanupId}, ${args.organizerUserId}, 'organizer')
            ON CONFLICT (cleanup_id, user_id) DO NOTHING
          `
          await linkReportsInTx(tx, args.cleanupId, args.linkedReportIds, args.organizerUserId)
          await insertSlotsInTx(tx, args.cleanupId, args.slots)
          await claimEventMediaInTx(tx, args.cleanupId, args.host)
          if (args.copyFrom !== undefined) {
            await copyEventExtrasInTx(tx, args.cleanupId, args.copyFrom)
          }

          const created = await readById(tx, args.cleanupId, null)
          if (!created) throw AppError.internal()
          await touchUserActivity(tx, {
            userId: args.organizerUserId,
            lng: args.lng,
            lat: args.lat,
            at: created.createdAt,
          })
          if (idem !== undefined) {
            await tx`
              INSERT INTO idempotency_keys (key, scope, user_or_anon, response_snapshot)
              VALUES (
                ${idempotencyRowKey(idem)},
                ${idem.scope},
                ${idem.userOrAnon},
                ${sql.json({ cleanupId: args.cleanupId })}
              )
            `
          }
          return created
        })
        return { record, replayed: false }
      } catch (err) {
        if (isUniqueViolationOn(err, "cleanups_page_slug_uidx")) {
          throw AppError.validation({ pageSlug: "that address is already taken" })
        }
        if (idem === undefined || !isUniqueViolationOn(err, "idempotency_key_scope_owner_uk")) {
          throw err
        }
        const existingId = await readIdempotentCleanupId(idem)
        if (existingId === null) {
          throw AppError.conflict("Event create is still settling; retry")
        }
        const record = await readById(sql, existingId, null)
        if (record === null) throw AppError.conflict("Event create is still settling; retry")
        return { record, replayed: true }
      }
    },

    async updateCleanup(id: string, patch: UpdateCleanupPatch): Promise<boolean> {
      const sets: postgres.Fragment[] = hostSetFragments(sql, patch)
      if (patch.title !== undefined) sets.push(sql`title = ${patch.title}`)
      if (patch.description !== undefined) sets.push(sql`description = ${patch.description}`)
      if (patch.eventKind !== undefined) sets.push(sql`event_kind = ${patch.eventKind}`)
      if (patch.type !== undefined) sets.push(sql`type = ${patch.type}`)
      if (patch.scheduledAt !== undefined) sets.push(sql`scheduled_at = ${patch.scheduledAt}`)
      if (patch.lat !== undefined && patch.lng !== undefined) {
        sets.push(sql`geom = ST_SetSRID(ST_MakePoint(${patch.lng}, ${patch.lat}), 4326)`)
      }
      if (patch.address !== undefined) sets.push(sql`address = ${patch.address}`)
      if (patch.addressSource !== undefined) {
        sets.push(sql`address_source = ${patch.addressSource}`)
      }
      if (patch.bring !== undefined) {
        sets.push(sql`bring = ${patch.bring as unknown as string[] | null}`)
      }
      if (patch.jurisdictionGeoid !== undefined) {
        sets.push(sql`jurisdiction_geoid = ${patch.jurisdictionGeoid}`)
      }

      if (sets.length === 0) {
        const rows = await sql<{ id: string }[]>`SELECT id FROM cleanups WHERE id = ${id} LIMIT 1`
        return rows.length > 0
      }
      const setList = sets.reduce((acc, frag, i) => (i === 0 ? frag : sql`${acc}, ${frag}`))
      return sql.begin(async (tx) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE cleanups SET ${setList} WHERE id = ${id} RETURNING id
        `
        if (updated.length === 0) return false
        await claimEventMediaInTx(tx, id, patch)
        return true
      })
    },

    async linkReports(
      cleanupId: string,
      reportIds: string[],
      actorId: string | null,
    ): Promise<string[]> {
      if (reportIds.length === 0) return []
      return sql.begin((tx) => linkReportsInTx(tx, cleanupId, reportIds, actorId))
    },

    async unlinkReport(
      cleanupId: string,
      reportId: string,
      actorId: string | null,
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const removed = await tx<{ id: string }[]>`
          DELETE FROM cleanup_reports
          WHERE cleanup_id = ${cleanupId} AND report_id = ${reportId}
          RETURNING id
        `
        if (removed.length === 0) return false
        await tx`
          INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
          VALUES (${cleanupId}, 'report_unlinked', ${`Unlinked report ${reportId}`}, ${actorId})
        `
        return true
      })
    },

    async reconcileLinkedReports(
      cleanupId: string,
      desiredIds: string[],
      actorId: string | null,
    ): Promise<{ added: string[]; removed: string[] }> {
      return sql.begin(async (tx) => {
        const existing = await tx<{ report_id: string }[]>`
          SELECT report_id FROM cleanup_reports WHERE cleanup_id = ${cleanupId}
        `
        const have = new Set(existing.map((r) => r.report_id))
        const want = new Set(desiredIds)
        const toAdd = desiredIds.filter((id) => !have.has(id))
        const droppable = [...have].filter((id) => !want.has(id))
        const visible = await selectVisibleReportIds(tx, droppable)
        const toRemove = droppable.filter((id) => visible.has(id))

        const added = await linkReportsInTx(tx, cleanupId, toAdd, actorId)
        if (toRemove.length > 0) {
          await tx`
            DELETE FROM cleanup_reports
            WHERE cleanup_id = ${cleanupId} AND report_id = ANY(${toRemove}::uuid[])
          `
          await tx`
            INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
            SELECT ${cleanupId}, 'report_unlinked', 'Unlinked report ' || rid, ${actorId}
            FROM unnest(${toRemove}::uuid[]) AS rid
          `
        }
        return { added, removed: toRemove }
      })
    },

    async loadLinkedReportsForCleanups(
      cleanupIds: string[],
      perCleanupCap: number = MAX_LINKED_REPORTS,
    ): Promise<Map<string, LinkedReportView[]>> {
      const grouped = new Map<string, LinkedReportView[]>()
      if (cleanupIds.length === 0) return grouped
      const rows = await sql<
        {
          cleanup_id: string
          id: string
          category: ReportCategory
          type: ReportType
          title: string | null
          status: ReportStatus
          lng: number
          lat: number
          addr: string | null
          thumb_key: string | null
          linked_at: Date
        }[]
      >`
        SELECT
          cleanup_id, id, category, type, title, status, lng, lat, addr, thumb_key, linked_at
        FROM (
          SELECT
            cr.cleanup_id,
            r.id,
            r.category,
            r.type,
            r.title,
            r.status,
            ST_X(r.geom) AS lng,
            ST_Y(r.geom) AS lat,
            r.addr,
            COALESCE(m.thumb_key, m.r2_key) AS thumb_key,
            cr.linked_at,
            row_number() OVER (
              PARTITION BY cr.cleanup_id ORDER BY cr.linked_at DESC, r.id
            ) AS rn
          FROM cleanup_reports cr
          JOIN reports r ON r.id = cr.report_id
          ${firstReadyStillLateral(sql)}
          WHERE cr.cleanup_id = ANY(${cleanupIds}::uuid[])
            AND ${publicReportFilter(sql)}
        ) ranked
        WHERE rn <= ${perCleanupCap}
        ORDER BY cleanup_id, linked_at DESC, id
      `
      for (const r of rows) {
        const view: LinkedReportView = {
          cleanupId: r.cleanup_id,
          id: r.id,
          category: r.category,
          type: r.type,
          title: r.title,
          status: r.status,
          lat: r.lat,
          lng: r.lng,
          addr: r.addr,
          thumbKey: r.thumb_key,
          linkedAt: r.linked_at,
        }
        const list = grouped.get(r.cleanup_id)
        if (list) list.push(view)
        else grouped.set(r.cleanup_id, [view])
      }
      return grouped
    },

    async loadLinkedEventsForReports(
      reportIds: string[],
    ): Promise<Map<string, LinkedEventView[]>> {
      const grouped = new Map<string, LinkedEventView[]>()
      if (reportIds.length === 0) return grouped
      const rows = await sql<
        {
          report_id: string
          id: string
          title: string
          event_kind: EventKind
          status: CleanupStatus
          scheduled_at: Date
          ends_at: Date | null
          timezone: string | null
          lng: number
          lat: number
          going: number
          org_id: string
          org_display_name: string
          org_handle: string | null
          org_bio: string | null
          org_avatar_url: string | null
          org_donation_url: string | null
          linked_at: Date
        }[]
      >`
        SELECT
          report_id, id, title, event_kind, status, scheduled_at, ends_at, timezone,
          lng, lat, going, org_id, org_display_name, org_handle, org_bio, org_avatar_url,
          org_donation_url, linked_at
        FROM (
          SELECT
            cr.report_id,
            c.id,
            c.title,
            c.event_kind,
            ${cleanupStatusExpr(sql)} AS status,
            c.scheduled_at,
            c.ends_at,
            c.timezone,
            ST_X(c.geom) AS lng,
            ST_Y(c.geom) AS lat,
            ${goingScalar(sql)} AS going,
            u.id AS org_id,
            u.display_name AS org_display_name,
            u.handle AS org_handle,
            u.bio AS org_bio,
            u.avatar_url AS org_avatar_url,
            u.donation_url AS org_donation_url,
            cr.linked_at,
            row_number() OVER (
              PARTITION BY cr.report_id ORDER BY cr.linked_at DESC, c.id
            ) AS rn
          FROM cleanup_reports cr
          JOIN cleanups c ON c.id = cr.cleanup_id
          JOIN users u ON u.id = c.organizer_user_id
          WHERE cr.report_id = ANY(${reportIds}::uuid[])
            AND c.visibility = 'public'
        ) ranked
        WHERE rn <= ${LINKED_EVENTS_PER_REPORT_CAP}
        ORDER BY report_id, linked_at DESC, id
      `
      for (const r of rows) {
        const view: LinkedEventView = {
          reportId: r.report_id,
          id: r.id,
          title: r.title,
          eventKind: r.event_kind,
          status: r.status,
          scheduledAt: r.scheduled_at,
          endsAt: r.ends_at,
          timezone: r.timezone,
          lat: r.lat,
          lng: r.lng,
          going: r.going,
          organizer: {
            id: r.org_id,
            displayName: r.org_display_name,
            handle: r.org_handle,
            bio: r.org_bio,
            avatarUrl: r.org_avatar_url,
            donationUrl: r.org_donation_url,
          },
          linkedAt: r.linked_at,
        }
        const list = grouped.get(r.report_id)
        if (list) list.push(view)
        else grouped.set(r.report_id, [view])
      }
      return grouped
    },

    async filterVisibleReportIds(reportIds: string[]): Promise<Set<string>> {
      return selectVisibleReportIds(sql, reportIds)
    },

    async findCleanupById(id: string, near: NearPoint | null): Promise<CleanupRecord | null> {
      return readById(sql, id, near)
    },

    async findCleanupByReferenceCode(code: string): Promise<CleanupRecord | null> {
      const rows = await sql<CleanupRowSelect[]>`
        SELECT ${cleanupColumns(sql, null)}
        FROM cleanups c
        JOIN users u ON u.id = c.organizer_user_id
        ${goingJoin(sql)}
        ${eventHostJoins(sql)}
        WHERE c.reference_code = ${code}
        LIMIT 1
      `
      return rows[0] ? toRecord(rows[0]) : null
    },

    async findCleanupByPageSlug(slug: string): Promise<CleanupRecord | null> {
      const rows = await sql<CleanupRowSelect[]>`
        SELECT ${cleanupColumns(sql, null)}
        FROM cleanups c
        JOIN users u ON u.id = c.organizer_user_id
        ${goingJoin(sql)}
        ${eventHostJoins(sql)}
        WHERE c.page_slug = ${slug}
        LIMIT 1
      `
      return rows[0] ? toRecord(rows[0]) : null
    },

    async galleryKeysFor(cleanupId: string): Promise<string[]> {
      const rows = await sql<{ served_key: string | null }[]>`
        SELECT ${servedKeyExpr(sql, "ma")} AS served_key
        FROM cleanups c
        JOIN LATERAL unnest(c.gallery_media_ids) WITH ORDINALITY AS g(media_id, ord) ON true
        JOIN media_assets ma ON ma.id = g.media_id
        WHERE c.id = ${cleanupId}
          AND ${servableMediaFilter(sql, "ma")}
        ORDER BY g.ord
      `
      return rows.flatMap((r) => (r.served_key === null ? [] : [r.served_key]))
    },

    async loadOrganizationRef(organizationId: string): Promise<CleanupOrganizationView | null> {
      const rows = await sql<
        {
          id: string
          slug: string
          name: string
          logo_key: string | null
          donation_url: string | null
          verified_status: OrgVerificationStatus
          verified_kind: OrgVerificationKind | null
          suspended: boolean
        }[]
      >`
        SELECT o.id, o.slug, o.name,
               ${servedKeyExpr(sql, "am")} AS logo_key,
               o.donation_url,
               o.verified_status, o.verified_kind,
               (o.suspended_at IS NOT NULL) AS suspended
        FROM organizations o
        LEFT JOIN media_assets am ON am.id = o.logo_media_id
        WHERE o.id = ${organizationId} AND o.deleted_at IS NULL
        LIMIT 1
      `
      const row = rows[0]
      if (row === undefined) return null
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        logoKey: row.logo_key,
        donationUrl: row.donation_url,
        verifiedStatus: row.verified_status,
        verifiedKind: row.verified_kind,
        suspended: row.suspended,
      }
    },

    async findOrganizationEventsHost(
      slug: string,
      viewerId: string | null,
    ): Promise<OrganizationEventsHost | null> {
      const rows = await sql<
        {
          id: string
          slug: string
          name: string
          logo_key: string | null
          donation_url: string | null
          verified_status: OrgVerificationStatus
          verified_kind: OrgVerificationKind | null
          suspended: boolean
          viewer_is_member: boolean
        }[]
      >`
        SELECT o.id, o.slug, o.name,
               ${servedKeyExpr(sql, "am")} AS logo_key,
               o.donation_url,
               o.verified_status, o.verified_kind,
               (o.suspended_at IS NOT NULL) AS suspended,
               EXISTS (
                 SELECT 1 FROM organization_members m
                 WHERE m.organization_id = o.id AND m.user_id = ${viewerId}::uuid
               ) AS viewer_is_member
        FROM organizations o
        LEFT JOIN media_assets am ON am.id = o.logo_media_id
        WHERE o.slug = ${slug} AND o.deleted_at IS NULL
        LIMIT 1
      `
      const row = rows[0]
      if (row === undefined) return null
      return {
        organization: {
          id: row.id,
          slug: row.slug,
          name: row.name,
          logoKey: row.logo_key,
          donationUrl: row.donation_url,
          verifiedStatus: row.verified_status,
          verifiedKind: row.verified_kind,
          suspended: row.suspended,
        },
        viewerIsMember: row.viewer_is_member,
      }
    },

    orgRoleOf(organizationId: string, userId: string): Promise<OrganizationMemberRole | null> {
      return orgStandingOf(sql, organizationId, userId)
    },

    async standingOf(cleanupId: string, userId: string): Promise<HostStanding> {
      const resolved = await hostStandingOf(sql, cleanupId, userId)
      return resolved?.standing ?? NO_HOST_STANDING
    },

    standingsOf(cleanupIds: string[], userId: string): Promise<Map<string, HostStanding>> {
      return hostStandingsOf(sql, cleanupIds, userId).then((resolved) => {
        const out = new Map<string, HostStanding>()
        for (const [id, resolution] of resolved) out.set(id, resolution.standing)
        return out
      })
    },

    async listCleanups(
      filters: ListCleanupsFilters,
    ): Promise<{ records: CleanupRecord[]; nextCursor: string | null }> {
      const near = filters.near ?? null
      const whenFilter = buildWhenFilter(sql, filters.when)
      const bboxFilter = buildBboxFilter(sql, filters.bbox)
      const membershipFilter = buildMembershipFilter(sql, filters.when, filters.viewerId)
      const visibilityFilter = buildVisibilityFilter(sql, filters.viewerId)

      if (near !== null) {
        const point = sql`ST_SetSRID(ST_MakePoint(${near.lng}, ${near.lat}), 4326)`
        const cursor = parseNearCursor(filters.cursor)
        const cursorFilter =
          cursor !== null
            ? sql`AND (c.geom <-> ${point}, c.id) > (${cursor.dist}::float8, ${cursor.id}::uuid)`
            : sql``
        const rows = await sql<CleanupRowSelect[]>`
          SELECT ${cleanupColumns(sql, near)}, (c.geom <-> ${point}) AS knn
          FROM cleanups c
          JOIN users u ON u.id = c.organizer_user_id
          ${goingJoin(sql)}
          ${eventHostJoins(sql)}
          WHERE TRUE
            ${whenFilter}
            ${membershipFilter}
            ${bboxFilter}
            ${visibilityFilter}
            ${cursorFilter}
          ORDER BY c.geom <-> ${point} ASC, c.id ASC
          LIMIT ${filters.limit + 1}
        `
        return paginate(rows, filters.limit, (last) =>
          last.knn === null || last.knn === undefined
            ? null
            : encodeNearCursor({ dist: Number(last.knn), id: last.id }),
        )
      }

      const past = filters.when === "past"
      const cursor = parseTimeCursor(filters.cursor)
      const cursorFilter =
        cursor !== null
          ? past
            ? sql`AND (c.scheduled_at, c.id) < (${cursor.at}, ${cursor.id}::uuid)`
            : sql`AND (c.scheduled_at, c.id) > (${cursor.at}, ${cursor.id}::uuid)`
          : sql``
      const order = past
        ? sql`ORDER BY c.scheduled_at DESC, c.id DESC`
        : sql`ORDER BY c.scheduled_at ASC, c.id ASC`
      const rows = await sql<CleanupRowSelect[]>`
        SELECT ${cleanupColumns(sql, null)}
        FROM cleanups c
        JOIN users u ON u.id = c.organizer_user_id
        ${goingJoin(sql)}
        ${eventHostJoins(sql)}
        WHERE TRUE
          ${whenFilter}
          ${membershipFilter}
          ${bboxFilter}
          ${visibilityFilter}
          ${cursorFilter}
        ${order}
        LIMIT ${filters.limit + 1}
      `
      return paginate(rows, filters.limit, (last) =>
        encodeTimeCursor({ at: last.scheduled_at, id: last.id }),
      )
    },

    async listOrganizationEvents(
      filters: OrganizationEventsFilters,
    ): Promise<{ records: CleanupRecord[]; nextCursor: string | null }> {
      const past = filters.when === "past"
      const cursor = parseTimeCursor(filters.cursor)
      const cursorFilter =
        cursor !== null
          ? past
            ? sql`AND (c.scheduled_at, c.id) < (${cursor.at}, ${cursor.id}::uuid)`
            : sql`AND (c.scheduled_at, c.id) > (${cursor.at}, ${cursor.id}::uuid)`
          : sql``
      const order = past
        ? sql`ORDER BY c.scheduled_at DESC, c.id DESC`
        : sql`ORDER BY c.scheduled_at ASC, c.id ASC`
      const rows = await sql<CleanupRowSelect[]>`
        SELECT ${cleanupColumns(sql, null)}
        FROM cleanups c
        JOIN users u ON u.id = c.organizer_user_id
        ${goingJoin(sql)}
        ${eventHostJoins(sql)}
        WHERE c.organization_id = ${filters.organizationId}
          AND c.visibility = 'public'
          ${buildWhenFilter(sql, filters.when)}
          ${cursorFilter}
        ${order}
        LIMIT ${filters.limit + 1}
      `
      return paginate(rows, filters.limit, (last) =>
        encodeTimeCursor({ at: last.scheduled_at, id: last.id }),
      )
    },

    async isMember(cleanupId: string, userId: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM cleanup_members
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
        LIMIT 1
      `
      return rows.length > 0
    },

    async roleOf(cleanupId: string, userId: string): Promise<CleanupMemberRole | null> {
      const rows = await sql<{ role: CleanupMemberRole }[]>`
        SELECT role FROM cleanup_members
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
        LIMIT 1
      `
      return rows[0]?.role ?? null
    },

    async rolesOf(cleanupIds: string[], userId: string): Promise<Map<string, CleanupMemberRole>> {
      if (cleanupIds.length === 0) return new Map()
      const rows = await sql<{ cleanup_id: string; role: CleanupMemberRole }[]>`
        SELECT cleanup_id, role FROM cleanup_members
        WHERE user_id = ${userId} AND cleanup_id = ANY(${cleanupIds}::uuid[])
      `
      return new Map(rows.map((r) => [r.cleanup_id, r.role]))
    },

    async setMemberRole(
      cleanupId: string,
      userId: string,
      role: "cohost" | "staff" | "coordinator" | "member",
    ): Promise<boolean> {
      const rows = await sql<{ user_id: string }[]>`
        UPDATE cleanup_members SET role = ${role}
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId} AND role <> 'organizer'
        RETURNING user_id
      `
      return rows.length > 0
    },

    async removeMember(
      cleanupId: string,
      userId: string,
      actorId: string,
    ): Promise<RemoveMemberOutcome> {
      return sql.begin(async (tx) => {
        const locked = await tx<{ status: CleanupStatus; now: Date }[]>`
          SELECT status, now() AS now FROM cleanups WHERE id = ${cleanupId} LIMIT 1 FOR NO KEY UPDATE
        `
        const cleanup = locked[0]
        if (cleanup === undefined) return { kind: "not_found" }
        if (cleanup.status === "cancelled") return { kind: "closed" }
        const deleted = await tx<{ user_id: string }[]>`
          DELETE FROM cleanup_members
          WHERE cleanup_id = ${cleanupId} AND user_id = ${userId} AND role <> 'organizer'
          RETURNING user_id
        `
        if (deleted.length > 0) {
          await cancelSignupRegistrationIn(tx, {
            cleanupId,
            userId,
            actorId,
            now: cleanup.now,
          })
          await tx`
            INSERT INTO cleanup_bans (cleanup_id, user_id, banned_by_user_id)
            VALUES (${cleanupId}, ${userId}, ${actorId})
            ON CONFLICT (cleanup_id, user_id) DO NOTHING
          `
          await tx`
            DELETE FROM cleanup_slot_claims
            WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
          `
        }
        const counted = await tx<{ count: number }[]>`
          SELECT
            (SELECT count(*)::int FROM cleanup_members m WHERE m.cleanup_id = ${cleanupId})
            + (
              SELECT count(*)::int FROM cleanup_guests cg
              WHERE cg.cleanup_id = ${cleanupId} AND cg.cancelled_at IS NULL
            ) AS count
        `
        const going = counted[0]?.count ?? 0
        return deleted.length > 0 ? { kind: "removed", going } : { kind: "not_member", going }
      })
    },

    async isBanned(cleanupId: string, userId: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM cleanup_bans
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
        LIMIT 1
      `
      return rows.length > 0
    },

    async unbanMember(cleanupId: string, userId: string): Promise<boolean> {
      const rows = await sql<{ user_id: string }[]>`
        DELETE FROM cleanup_bans
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
        RETURNING user_id
      `
      return rows.length > 0
    },

    async listMemberIds(cleanupId: string, limit: number): Promise<string[]> {
      const rows = await sql<{ user_id: string }[]>`
        SELECT user_id FROM cleanup_members
        WHERE cleanup_id = ${cleanupId}
        ORDER BY joined_at ASC, user_id ASC
        LIMIT ${limit}
      `
      return rows.map((r) => r.user_id)
    },

    async goingCount(cleanupId: string): Promise<number> {
      const rows = await sql<{ count: number }[]>`
        SELECT
          (SELECT count(*)::int FROM cleanup_members m WHERE m.cleanup_id = ${cleanupId})
          + (
            SELECT count(*)::int FROM cleanup_guests cg
            WHERE cg.cleanup_id = ${cleanupId} AND cg.cancelled_at IS NULL
          ) AS count
      `
      return rows[0]?.count ?? 0
    },

    async organizerOf(cleanupId: string): Promise<string | null> {
      const rows = await sql<{ organizer_user_id: string }[]>`
        SELECT organizer_user_id FROM cleanups WHERE id = ${cleanupId} LIMIT 1
      `
      return rows[0]?.organizer_user_id ?? null
    },

    async joinCleanupTx(
      cleanupId: string,
      userId: string,
      seat: SignupSeat,
    ): Promise<JoinCleanupOutcome> {
      return sql.begin(async (tx) => {
        const locked = await tx<
          {
            status: CleanupStatus
            visibility: EventVisibility
            organization_id: string | null
            scheduled_at: Date
            ends_at: Date | null
            now: Date
          }[]
        >`
          SELECT status, visibility, organization_id, scheduled_at, ends_at, now() AS now
          FROM cleanups
          WHERE id = ${cleanupId} LIMIT 1 FOR SHARE
        `
        const cleanup = locked[0]
        if (cleanup === undefined) return "not_found"
        if (
          await privateEventBlocksJoin(
            tx,
            cleanupId,
            cleanup.visibility,
            cleanup.organization_id,
            userId,
          )
        ) {
          return "not_found"
        }
        if (cleanup.status === "cancelled") return "closed"
        if (hasEventEnded(eventWindowOfRow(cleanup), cleanup.now.getTime())) return "ended"
        const banned = await tx<{ one: number }[]>`
          SELECT 1 AS one FROM cleanup_bans
          WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
          LIMIT 1
        `
        if (banned.length > 0) return "banned"
        await tx`
          INSERT INTO cleanup_members (cleanup_id, user_id, role)
          VALUES (${cleanupId}, ${userId}, 'member')
          ON CONFLICT (cleanup_id, user_id) DO NOTHING
        `
        await ensureSignupRegistrationIn(tx, {
          cleanupId,
          userId,
          seatId: seat.seatId,
          tokenHash: seat.tokenHash,
          now: cleanup.now,
        })
        return "joined"
      })
    },

    async leaveCleanup(cleanupId: string, userId: string): Promise<LeaveCleanupOutcome> {
      return sql.begin(async (tx) => {
        const locked = await tx<{ status: CleanupStatus; now: Date }[]>`
          SELECT status, now() AS now FROM cleanups WHERE id = ${cleanupId} LIMIT 1 FOR SHARE
        `
        const cleanup = locked[0]
        if (cleanup === undefined) return "not_found"
        if (cleanup.status === "cancelled") return "closed"
        await tx`
          DELETE FROM cleanup_members WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
        `
        await cancelSignupRegistrationIn(tx, {
          cleanupId,
          userId,
          actorId: userId,
          now: cleanup.now,
        })
        await tx`
          DELETE FROM cleanup_slot_claims WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
        `
        return "left"
      })
    },

    async cancelCleanupTx(
      id: string,
      input: { note: string; body: string; reason: string | null; actorId: string },
    ): Promise<CancelCleanupOutcome> {
      return sql.begin(async (tx) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE cleanups SET status = 'cancelled'
          WHERE id = ${id} AND status <> 'cancelled' AND ends_at > now()
          RETURNING id
        `
        if (updated.length === 0) {
          const existing = await tx<{ status: CleanupStatus }[]>`
            SELECT status FROM cleanups WHERE id = ${id} LIMIT 1
          `
          const status = existing[0]?.status
          if (status === undefined) return "not_found"
          return status === "cancelled" ? "already_cancelled" : "already_ended"
        }
        await tx`
          INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
          VALUES (${id}, 'cancel', ${input.note}, ${input.actorId})
        `
        return "cancelled"
      })
    },

    async listAttendees(args: ListAttendeesArgs): Promise<AttendeeView[]> {
      const { cleanupId, viewerId, onlyFollowed, limit } = args
      const followingExpr =
        viewerId !== null
          ? sql`EXISTS (SELECT 1 FROM follows_people f WHERE f.follower_id = ${viewerId} AND f.followee_id = u.id)`
          : sql`FALSE`
      const onlyFollowedFilter = onlyFollowed
        ? viewerId !== null
          ? sql`AND EXISTS (SELECT 1 FROM follows_people f2 WHERE f2.follower_id = ${viewerId} AND f2.followee_id = u.id)`
          : sql`AND FALSE`
        : sql``
      const blockedPair = blockedPairExpr(sql, viewerId, sql`u.id`)
      const rows = await sql<
        (AttendeeRowSelect & {
          slot_id: string | null
          slot_title: string | null
          blocked_pair: boolean
        })[]
      >`
        SELECT
          u.id,
          u.display_name,
          u.handle,
          u.bio,
          u.avatar_url,
          m.role,
          ${followingExpr} AS is_following,
          ${blockedPair} AS blocked_pair,
          cs.id AS slot_id,
          cs.title AS slot_title
        FROM cleanup_members m
        JOIN users u ON u.id = m.user_id
        LEFT JOIN cleanup_slot_claims csc
          ON csc.cleanup_id = m.cleanup_id AND csc.user_id = m.user_id
        LEFT JOIN cleanup_slots cs ON cs.id = csc.slot_id
        WHERE m.cleanup_id = ${cleanupId}
          AND u.deleted_at IS NULL
          ${onlyFollowedFilter}
        ORDER BY
          CASE m.role
            WHEN 'organizer' THEN 0 WHEN 'cohost' THEN 1 WHEN 'coordinator' THEN 2
            WHEN 'staff' THEN 3 ELSE 4
          END,
          m.joined_at ASC,
          u.id ASC
        LIMIT ${limit}
      `
      return rows.map((r) => {
        const hidden = r.blocked_pair ? hiddenIdentity(r.id) : null
        return {
          id: r.id,
          displayName: hidden?.name ?? r.display_name,
          handle: hidden !== null ? null : r.handle,
          bio: hidden !== null ? null : r.bio,
          avatarUrl: hidden !== null ? null : r.avatar_url,
          role: r.role,
          isFollowing: r.is_following,
          slot:
            r.slot_id !== null && r.slot_title !== null
              ? { id: r.slot_id, title: r.slot_title }
              : null,
          ...(hidden !== null ? { identityHidden: true } : {}),
        }
      })
    },

    async listSlots(cleanupId: string, viewerId: string | null): Promise<EventSlotView[]> {
      const grouped = await loadSlots(sql, [cleanupId], viewerId)
      return grouped.get(cleanupId) ?? []
    },

    async loadSlotsForCleanups(
      cleanupIds: string[],
      viewerId: string | null,
    ): Promise<Map<string, EventSlotView[]>> {
      return loadSlots(sql, cleanupIds, viewerId)
    },

    async slotCountsFor(cleanupIds: string[]): Promise<Map<string, number>> {
      if (cleanupIds.length === 0) return new Map()
      const rows = await sql<{ cleanup_id: string; n: number }[]>`
        SELECT cleanup_id, count(*)::int AS n
        FROM cleanup_slots
        WHERE cleanup_id = ANY(${cleanupIds}::uuid[])
        GROUP BY cleanup_id
      `
      return new Map(rows.map((r) => [r.cleanup_id, r.n]))
    },

    async reconcileSlots(
      cleanupId: string,
      desired: DesiredSlot[],
      actorId: string | null,
    ): Promise<SlotReconcileResult> {
      try {
        return await sql.begin(async (tx) => {
          const existing = await tx<
            { id: string; title: string; starts_at: Date | null; ends_at: Date | null }[]
          >`
            SELECT id, title, starts_at, ends_at FROM cleanup_slots WHERE cleanup_id = ${cleanupId}
          `
          const have = new Map<string, SlotIdentity>(
            existing.map((r) => [r.id, { title: r.title, startsAt: r.starts_at, endsAt: r.ends_at }]),
          )

          for (const slot of desired) {
            if (slot.id !== undefined && !have.has(slot.id)) {
              throw AppError.validation({ slots: `unknown slot: ${slot.id}` })
            }
          }


          const keep = new Set(desired.map((s) => s.id).filter((id): id is string => id !== undefined))
          const toRemove = [...have.keys()].filter((id) => !keep.has(id))
          const removed: SlotReconcileResult["removed"] = []
          if (toRemove.length > 0) {
            const claimants = await tx<{ slot_id: string; user_id: string }[]>`
              SELECT slot_id, user_id FROM cleanup_slot_claims
              WHERE cleanup_id = ${cleanupId} AND slot_id = ANY(${toRemove}::uuid[])
            `
            const bySlot = new Map<string, string[]>()
            for (const c of claimants) {
              const list = bySlot.get(c.slot_id)
              if (list) list.push(c.user_id)
              else bySlot.set(c.slot_id, [c.user_id])
            }
            await tx`
              DELETE FROM cleanup_slots
              WHERE cleanup_id = ${cleanupId} AND id = ANY(${toRemove}::uuid[])
            `
            for (const slotId of toRemove) {
              removed.push({
                slotId,
                title: have.get(slotId)?.title ?? "",
                claimantUserIds: (bySlot.get(slotId) ?? []).filter((u) => u !== actorId),
              })
            }
          }

          const kept = desired.filter((s): s is DesiredSlot & { id: string } => s.id !== undefined)
          const changed = (slot: DesiredSlot & { id: string }, keyOf: (s: SlotIdentity) => string): boolean => {
            const before = have.get(slot.id)
            return before === undefined || keyOf(before) !== keyOf(slot)
          }
          const rekeying = kept.filter((s) => changed(s, slotIdentityKey)).map((s) => s.id)
          if (rekeying.length > 0) {
            await tx`
              UPDATE cleanup_slots SET title = id::text
              WHERE cleanup_id = ${cleanupId} AND id = ANY(${rekeying}::uuid[])
            `
          }

          const movedIds = kept.filter((s) => changed(s, slotWindowKey)).map((s) => s.id)
          const rescheduled: SlotReconcileResult["rescheduled"] = []
          if (movedIds.length > 0) {
            const claimants = await tx<{ slot_id: string; user_id: string }[]>`
              SELECT slot_id, user_id FROM cleanup_slot_claims
              WHERE cleanup_id = ${cleanupId} AND slot_id = ANY(${movedIds}::uuid[])
            `
            const bySlot = new Map<string, string[]>()
            for (const c of claimants) {
              if (c.user_id === actorId) continue
              const list = bySlot.get(c.slot_id)
              if (list) list.push(c.user_id)
              else bySlot.set(c.slot_id, [c.user_id])
            }
            for (const slot of kept) {
              const userIds = bySlot.get(slot.id)
              if (userIds === undefined || userIds.length === 0) continue
              rescheduled.push({ slotId: slot.id, title: slot.title, claimantUserIds: userIds })
            }
          }

          const added: string[] = []
          const updated: string[] = []
          for (const slot of desired) {
            if (slot.id !== undefined) {
              await tx`
                UPDATE cleanup_slots SET
                  title = ${slot.title},
                  description = ${slot.description},
                  capacity = ${slot.capacity},
                  starts_at = ${slot.startsAt},
                  ends_at = ${slot.endsAt},
                  sort_order = ${slot.sortOrder}
                WHERE id = ${slot.id} AND cleanup_id = ${cleanupId}
              `
              updated.push(slot.id)
            } else {
              const [row] = await tx<{ id: string }[]>`
                INSERT INTO cleanup_slots (cleanup_id, title, description, capacity, starts_at, ends_at, sort_order)
                VALUES (
                  ${cleanupId}, ${slot.title}, ${slot.description}, ${slot.capacity},
                  ${slot.startsAt}, ${slot.endsAt}, ${slot.sortOrder}
                )
                RETURNING id
              `
              if (row) added.push(row.id)
            }
          }
          return { added, updated, removed, rescheduled }
        })
      } catch (err) {
        if (isSlotTitleConflict(err)) {
          throw AppError.validation({ slots: "duplicate slot title" })
        }
        throw err
      }
    },

    async claimSlot(
      cleanupId: string,
      userId: string,
      slotId: string,
      seat: SignupSeat,
    ): Promise<ClaimSlotOutcome> {
      return sql.begin(async (tx) => {
        const locked = await tx<
          {
            status: CleanupStatus
            visibility: EventVisibility
            organization_id: string | null
            scheduled_at: Date
            ends_at: Date | null
            now: Date
          }[]
        >`
          SELECT status, visibility, organization_id, scheduled_at, ends_at, now() AS now
          FROM cleanups
          WHERE id = ${cleanupId} LIMIT 1 FOR SHARE
        `
        const cleanup = locked[0]
        if (cleanup === undefined) return { kind: "not_found" }
        if (
          await privateEventBlocksJoin(
            tx,
            cleanupId,
            cleanup.visibility,
            cleanup.organization_id,
            userId,
          )
        ) {
          return { kind: "not_found" }
        }
        if (cleanup.status === "cancelled") return { kind: "closed" }
        if (hasEventEnded(eventWindowOfRow(cleanup), cleanup.now.getTime())) return { kind: "ended" }

        const banned = await tx<{ one: number }[]>`
          SELECT 1 AS one FROM cleanup_bans
          WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
          LIMIT 1
        `
        if (banned.length > 0) return { kind: "banned" }

        const mine = await tx<{ slot_id: string }[]>`
          SELECT slot_id FROM cleanup_slot_claims
          WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
          LIMIT 1
        `
        const currentSlotId = mine[0]?.slot_id ?? null

        const slotRows = await tx<{ capacity: number | null }[]>`
          SELECT capacity FROM cleanup_slots
          WHERE id = ${slotId} AND cleanup_id = ${cleanupId}
          LIMIT 1
          FOR UPDATE
        `
        const slot = slotRows[0]
        if (slot === undefined) return { kind: "slot_not_found" }

        if (currentSlotId === slotId) return { kind: "claimed", slotId }

        if (slot.capacity !== null) {
          const counted = await tx<{ n: number }[]>`
            SELECT count(*)::int AS n FROM cleanup_slot_claims WHERE slot_id = ${slotId}
          `
          if ((counted[0]?.n ?? 0) >= slot.capacity) return { kind: "full" }
        }

        await tx`
          INSERT INTO cleanup_members (cleanup_id, user_id, role)
          VALUES (${cleanupId}, ${userId}, 'member')
          ON CONFLICT (cleanup_id, user_id) DO NOTHING
        `

        await ensureSignupRegistrationIn(tx, {
          cleanupId,
          userId,
          seatId: seat.seatId,
          tokenHash: seat.tokenHash,
          now: cleanup.now,
        })

        await tx`
          INSERT INTO cleanup_slot_claims (cleanup_id, user_id, slot_id)
          VALUES (${cleanupId}, ${userId}, ${slotId})
          ON CONFLICT (cleanup_id, user_id)
          DO UPDATE SET slot_id = EXCLUDED.slot_id, claimed_at = now()
        `
        return { kind: "claimed", slotId }
      })
    },

    async releaseSlot(cleanupId: string, userId: string): Promise<ClaimSlotOutcome> {
      const rows = await sql<{ status: CleanupStatus }[]>`
        SELECT status FROM cleanups WHERE id = ${cleanupId} LIMIT 1
      `
      const status = rows[0]?.status
      if (status === undefined) return { kind: "not_found" }
      if (status === "cancelled") return { kind: "closed" }
      await sql`
        DELETE FROM cleanup_slot_claims WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
      `
      return { kind: "released" }
    },

    async slotOf(cleanupId: string, userId: string): Promise<string | null> {
      const rows = await sql<{ slot_id: string }[]>`
        SELECT slot_id FROM cleanup_slot_claims
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
        LIMIT 1
      `
      return rows[0]?.slot_id ?? null
    },

    async resolveJurisdictionContact(
      geoid: string | null,
    ): Promise<{ contact: string; name: string } | null> {
      if (geoid === null) return null
      const rows = await sql<{ name: string | null; default_email: string | null; legacy_email: string | null }[]>`
        SELECT
          j.name,
          (SELECT jc.email FROM jurisdiction_contacts jc
             WHERE jc.geoid = j.geoid AND jc.category IS NULL
               AND jc.email IS NOT NULL AND jc.email <> '' LIMIT 1) AS default_email,
          j.contact_emails[1] AS legacy_email
        FROM jurisdictions j
        WHERE j.geoid = ${geoid}
        LIMIT 1
      `
      const row = rows[0]
      if (!row) return null
      const contact = row.default_email ?? row.legacy_email ?? null
      if (contact === null || contact === "") return null
      return { contact, name: row.name ?? geoid }
    },

    async appendCleanupTimeline(
      cleanupId: string,
      input: { kind: string; note: string | null; actorId: string | null },
    ): Promise<void> {
      await sql`
        INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
        VALUES (${cleanupId}, ${input.kind}, ${input.note}, ${input.actorId})
      `
    },
  }
}

async function eventHasTicketTypes(tx: Queryable, cleanupId: string): Promise<boolean> {
  const rows = await tx<{ one: number }[]>`
    SELECT 1 AS one FROM cleanup_ticket_types WHERE cleanup_id = ${cleanupId} LIMIT 1
  `
  return rows.length > 0
}

export async function ensureSignupRegistrationIn(
  tx: Queryable,
  args: {
    cleanupId: string
    userId: string
    seatId: string
    tokenHash: string
    now: Date
  },
): Promise<string | null> {
  if (await eventHasTicketTypes(tx, args.cleanupId)) return null
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO cleanup_registrations (
      cleanup_id, ticket_type_id, user_id, guest_id, party_size, status, source, registered_at
    ) VALUES (
      ${args.cleanupId}, NULL, ${args.userId}, NULL, 1, 'registered', 'self', ${args.now}
    )
    ON CONFLICT (cleanup_id, user_id) WHERE status = 'registered' AND user_id IS NOT NULL
    DO NOTHING
    RETURNING id
  `
  const registrationId = inserted[0]?.id
  if (registrationId === undefined) return null
  await tx`
    INSERT INTO cleanup_registration_seats (
      id, cleanup_id, registration_id, seat_index, attendee_name, ticket_token_hash, status, created_at
    ) VALUES (
      ${args.seatId}, ${args.cleanupId}, ${registrationId}, 0, NULL, ${args.tokenHash}, 'active', ${args.now}
    )
  `
  return registrationId
}

export async function cancelSignupRegistrationIn(
  tx: Queryable,
  args: { cleanupId: string; userId: string; actorId: string | null; now: Date },
): Promise<boolean> {
  const cancelled = await tx<{ id: string }[]>`
    WITH cancelled AS (
      UPDATE cleanup_registrations
         SET status = 'cancelled', cancelled_at = ${args.now}, cancelled_by = ${args.actorId}
       WHERE cleanup_id = ${args.cleanupId}
         AND user_id = ${args.userId}
         AND status = 'registered'
         AND ticket_type_id IS NULL
      RETURNING id
    ), seats AS (
      UPDATE cleanup_registration_seats s
         SET status = 'cancelled'
        FROM cancelled c
       WHERE s.registration_id = c.id AND s.status = 'active'
      RETURNING s.id
    )
    SELECT id FROM cancelled
  `
  return cancelled.length > 0
}

async function selectVisibleReportIds(q: Queryable, reportIds: string[]): Promise<Set<string>> {
  if (reportIds.length === 0) return new Set()
  const rows = await q<{ id: string }[]>`
    SELECT r.id FROM reports r
    WHERE r.id = ANY(${reportIds}::uuid[])
      AND ${publicReportFilter(q)}
  `
  return new Set(rows.map((r) => r.id))
}

async function linkReportsInTx(
  tx: Queryable,
  cleanupId: string,
  reportIds: string[],
  actorId: string | null,
): Promise<string[]> {
  if (reportIds.length === 0) return []
  const overCap = await tx<{ report_id: string }[]>`
    SELECT cr.report_id
    FROM cleanup_reports cr
    WHERE cr.report_id = ANY(${reportIds}::uuid[])
      AND cr.cleanup_id <> ${cleanupId}
    GROUP BY cr.report_id
    HAVING count(*) >= ${MAX_EVENTS_PER_REPORT}
  `
  if (overCap.length > 0) {
    throw AppError.validation({
      linkedReportIds: `already linked to the maximum number of events: ${overCap
        .map((r) => r.report_id)
        .join(", ")}`,
    })
  }
  const inserted = await tx<{ report_id: string }[]>`
    INSERT INTO cleanup_reports (cleanup_id, report_id, linked_by_user_id)
    SELECT ${cleanupId}, rid, ${actorId}
    FROM unnest(${reportIds}::uuid[]) AS rid
    ON CONFLICT (cleanup_id, report_id) DO NOTHING
    RETURNING report_id
  `
  const newlyLinked = inserted.map((r) => r.report_id)
  if (newlyLinked.length > 0) {
    await tx`
      INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
      SELECT ${cleanupId}, 'report_linked', 'Linked report ' || rid, ${actorId}
      FROM unnest(${newlyLinked}::uuid[]) AS rid
    `
  }
  return newlyLinked
}

async function insertSlotsInTx(
  tx: Queryable,
  cleanupId: string,
  slots: DesiredSlot[],
): Promise<void> {
  if (slots.length === 0) return
  for (const slot of slots) {
    await tx`
      INSERT INTO cleanup_slots (cleanup_id, title, description, capacity, starts_at, ends_at, sort_order)
      VALUES (
        ${cleanupId}, ${slot.title}, ${slot.description}, ${slot.capacity},
        ${slot.startsAt}, ${slot.endsAt}, ${slot.sortOrder}
      )
    `
  }
}

async function loadSlots(
  tag: Sql,
  cleanupIds: string[],
  viewerId: string | null,
): Promise<Map<string, EventSlotView[]>> {
  const grouped = new Map<string, EventSlotView[]>()
  if (cleanupIds.length === 0) return grouped
  const rows = await tag<
    {
      cleanup_id: string
      id: string
      title: string
      description: string | null
      capacity: number | null
      starts_at: Date | null
      ends_at: Date | null
      sort_order: number
      claimed: number
      mine: boolean
    }[]
  >`
    SELECT s.cleanup_id, s.id, s.title, s.description, s.capacity, s.starts_at, s.ends_at, s.sort_order,
           COALESCE(c.n, 0)::int AS claimed,
           (mine.user_id IS NOT NULL) AS mine
    FROM cleanup_slots s
    LEFT JOIN (
      SELECT cl.slot_id, count(*) AS n
      FROM cleanup_slot_claims cl
      WHERE cl.cleanup_id = ANY(${cleanupIds}::uuid[])
      GROUP BY cl.slot_id
    ) c ON c.slot_id = s.id
    LEFT JOIN cleanup_slot_claims mine
      ON mine.slot_id = s.id AND mine.user_id = ${viewerId}
    WHERE s.cleanup_id = ANY(${cleanupIds}::uuid[])
    ORDER BY s.cleanup_id, s.sort_order, s.id
  `
  for (const r of rows) {
    const view: EventSlotView = {
      cleanupId: r.cleanup_id,
      id: r.id,
      title: r.title,
      description: r.description,
      capacity: r.capacity,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      sortOrder: r.sort_order,
      claimed: r.claimed,
      mine: r.mine,
    }
    const list = grouped.get(r.cleanup_id)
    if (list) list.push(view)
    else grouped.set(r.cleanup_id, [view])
  }
  return grouped
}

function paginate(
  rows: CleanupRowSelect[],
  limit: number,
  cursorOf: (last: CleanupRowSelect) => string | null,
): { records: CleanupRecord[]; nextCursor: string | null } {
  const { items, nextCursor } = pageWith(rows, limit, cursorOf)
  return { records: items.map(toRecord), nextCursor }
}
