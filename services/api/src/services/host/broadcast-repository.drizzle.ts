import { ANNOUNCEMENT_BROADCAST_KIND } from "@civfix/shared"
import type {
  BroadcastChannel,
  BroadcastKind,
  BroadcastSegment,
  BroadcastStatus,
  DeliveryStatus,
} from "@civfix/shared"
import type { Queryable, Sql } from "../../db/client.js"
import { listGuestAudiencePage, listMemberAudiencePage } from "./broadcast-audience-sql.js"
import type {
  AdminBroadcastListQuery,
  AnnouncementCap,
  AnnouncementListQuery,
  AudiencePageQuery,
  BroadcastListQuery,
  BroadcastRepository,
  DeliveryListQuery,
  DeliveryListRow,
} from "./broadcast-repository.js"
import type { NotificationPrefsRecord } from "../notification-service.js"
import type {
  AdminBroadcastRow,
  AdminHostListParams,
  AdminHostRow,
  BroadcastCreateInput,
  BroadcastDraftPatch,
  BroadcastRecord,
  BroadcastRecipientKind,
  DeliveryClaim,
  DeliveryCounts,
  DeliveryOutcome,
  DeliveryRowInput,
  DueReminder,
  EventBroadcastContext,
  GuestContact,
  HostMessagingState,
  MemberContact,
} from "./broadcast-types.js"
import { ANNOUNCEMENT_VISIBLE_STATUSES } from "./broadcast-types.js"

interface BroadcastRowSelect {
  id: string
  cleanup_id: string
  created_by: string | null
  kind: BroadcastKind
  reminder_offset_min: number | null
  status: BroadcastStatus
  subject: string | null
  body_md: string | null
  cta_label: string | null
  cta_url: string | null
  segment: BroadcastSegment | null
  channels: BroadcastChannel[]
  reply_to: string | null
  scheduled_at: Date | null
  planned_at: Date | null
  started_at: Date | null
  finished_at: Date | null
  chunk_size: number
  chunk_count: number
  recipient_count: number
  sent_count: number
  failed_count: number
  suppressed_count: number
  content_scrubbed_at: Date | null
  created_at: Date
  updated_at: Date | null
}

function toRecord(row: BroadcastRowSelect): BroadcastRecord {
  return {
    id: row.id,
    cleanupId: row.cleanup_id,
    createdBy: row.created_by,
    kind: row.kind,
    reminderOffsetMin: row.reminder_offset_min,
    status: row.status,
    subject: row.subject,
    bodyMd: row.body_md,
    ctaLabel: row.cta_label,
    ctaUrl: row.cta_url,
    segment: row.segment,
    channels: row.channels ?? [],
    replyTo: row.reply_to,
    scheduledAt: row.scheduled_at,
    plannedAt: row.planned_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    chunkSize: row.chunk_size,
    chunkCount: row.chunk_count,
    recipientCount: row.recipient_count,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    suppressedCount: row.suppressed_count,
    contentScrubbedAt: row.content_scrubbed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function joinSet(sql: Sql, fragments: Array<ReturnType<Sql>>): ReturnType<Sql> {
  return fragments.reduce((acc, frag, i) => (i === 0 ? frag : sql`${acc}, ${frag}`))
}

function jsonParam(sql: Sql, value: unknown): ReturnType<Sql["json"]> | null {
  return value === null || value === undefined
    ? null
    : sql.json(value as Parameters<typeof sql.json>[0])
}

function firstName(displayName: string): string {
  const trimmed = displayName.trim()
  if (trimmed.length === 0) return ""
  const space = trimmed.indexOf(" ")
  return space === -1 ? trimmed : trimmed.slice(0, space)
}

export function makeDrizzleBroadcastRepository(sql: Sql): BroadcastRepository {
  async function selectById(broadcastId: string): Promise<BroadcastRecord | null> {
    const rows = await sql<BroadcastRowSelect[]>`
      SELECT id, cleanup_id, created_by, kind, reminder_offset_min, status, subject, body_md,
               cta_label, cta_url, segment, channels, reply_to, scheduled_at, planned_at, started_at,
               finished_at, chunk_size, chunk_count, recipient_count, sent_count, failed_count,
               suppressed_count, content_scrubbed_at, created_at, updated_at FROM broadcasts WHERE id = ${broadcastId} LIMIT 1`
    return rows[0] ? toRecord(rows[0]) : null
  }

  async function insertBroadcast(
    db: Queryable,
    input: BroadcastCreateInput,
  ): Promise<BroadcastRecord> {
    const rows = await db<BroadcastRowSelect[]>`
        INSERT INTO broadcasts (
          cleanup_id, created_by, kind, reminder_offset_min, status, subject, body_md,
          cta_label, cta_url, segment, channels, reply_to, scheduled_at, chunk_size
        ) VALUES (
          ${input.cleanupId}, ${input.createdBy}, ${input.kind}, ${input.reminderOffsetMin ?? null},
          ${input.status ?? "draft"}, ${input.subject}, ${input.bodyMd}, ${input.ctaLabel ?? null},
          ${input.ctaUrl ?? null}, ${jsonParam(sql, input.segment)},
          ${input.channels}::text[], ${input.replyTo ?? null}, ${input.scheduledAt ?? null},
          ${input.chunkSize ?? 200}
        )
        RETURNING id, cleanup_id, created_by, kind, reminder_offset_min, status, subject, body_md,
               cta_label, cta_url, segment, channels, reply_to, scheduled_at, planned_at, started_at,
               finished_at, chunk_size, chunk_count, recipient_count, sent_count, failed_count,
               suppressed_count, content_scrubbed_at, created_at, updated_at`
    return toRecord(rows[0]!)
  }

  return {
    create(input: BroadcastCreateInput): Promise<BroadcastRecord> {
      return insertBroadcast(sql, input)
    },

    createAnnouncementUnderCap(
      input: BroadcastCreateInput,
      cap: AnnouncementCap,
    ): Promise<BroadcastRecord | null> {
      return sql.begin(async (tx) => {
        await tx`SELECT id FROM cleanups WHERE id = ${input.cleanupId} LIMIT 1 FOR UPDATE`
        const rows = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM broadcasts
           WHERE cleanup_id = ${input.cleanupId}
             AND kind = ${ANNOUNCEMENT_BROADCAST_KIND}
             AND created_at >= ${cap.since}`
        if ((rows[0]?.n ?? 0) >= cap.max) return null
        return insertBroadcast(tx, input)
      }) as Promise<BroadcastRecord | null>
    },

    async createIfAbsent(input: BroadcastCreateInput): Promise<BroadcastRecord | null> {
      const rows = await sql<BroadcastRowSelect[]>`
        INSERT INTO broadcasts (
          cleanup_id, created_by, kind, reminder_offset_min, status, subject, body_md,
          segment, channels, reply_to
        ) VALUES (
          ${input.cleanupId}, ${input.createdBy}, ${input.kind}, ${input.reminderOffsetMin ?? null},
          ${input.status ?? "sending"}, ${input.subject}, ${input.bodyMd},
          ${jsonParam(sql, input.segment)}, ${input.channels}::text[],
          ${input.replyTo ?? null}
        )
        ON CONFLICT DO NOTHING
        RETURNING id, cleanup_id, created_by, kind, reminder_offset_min, status, subject, body_md,
               cta_label, cta_url, segment, channels, reply_to, scheduled_at, planned_at, started_at,
               finished_at, chunk_size, chunk_count, recipient_count, sent_count, failed_count,
               suppressed_count, content_scrubbed_at, created_at, updated_at`
      return rows[0] ? toRecord(rows[0]) : null
    },

    findById: selectById,

    async findForEvent(cleanupId: string, broadcastId: string): Promise<BroadcastRecord | null> {
      const rows = await sql<BroadcastRowSelect[]>`
        SELECT id, cleanup_id, created_by, kind, reminder_offset_min, status, subject, body_md,
               cta_label, cta_url, segment, channels, reply_to, scheduled_at, planned_at, started_at,
               finished_at, chunk_size, chunk_count, recipient_count, sent_count, failed_count,
               suppressed_count, content_scrubbed_at, created_at, updated_at FROM broadcasts
         WHERE id = ${broadcastId} AND cleanup_id = ${cleanupId}
         LIMIT 1`
      return rows[0] ? toRecord(rows[0]) : null
    },

    async list(query: BroadcastListQuery): Promise<BroadcastRecord[]> {
      const statusFilter =
        query.status !== undefined ? sql`AND status = ${query.status}` : sql``
      const cursorFilter =
        query.cursor !== null
          ? sql`AND (created_at, id) < (${query.cursor.createdAt}, ${query.cursor.id})`
          : sql``
      const rows = await sql<BroadcastRowSelect[]>`
        SELECT id, cleanup_id, created_by, kind, reminder_offset_min, status, subject, body_md,
               cta_label, cta_url, segment, channels, reply_to, scheduled_at, planned_at, started_at,
               finished_at, chunk_size, chunk_count, recipient_count, sent_count, failed_count,
               suppressed_count, content_scrubbed_at, created_at, updated_at FROM broadcasts
         WHERE cleanup_id = ${query.cleanupId}
           ${statusFilter}
           ${cursorFilter}
         ORDER BY created_at DESC, id DESC
         LIMIT ${query.limit}`
      return rows.map(toRecord)
    },

    async listAnnouncements(query: AnnouncementListQuery): Promise<BroadcastRecord[]> {
      const cursorFilter =
        query.cursor !== null
          ? sql`AND (created_at, id) < (${query.cursor.createdAt}, ${query.cursor.id})`
          : sql``
      const rows = await sql<BroadcastRowSelect[]>`
        SELECT id, cleanup_id, created_by, kind, reminder_offset_min, status, subject, body_md,
               cta_label, cta_url, segment, channels, reply_to, scheduled_at, planned_at, started_at,
               finished_at, chunk_size, chunk_count, recipient_count, sent_count, failed_count,
               suppressed_count, content_scrubbed_at, created_at, updated_at FROM broadcasts
         WHERE cleanup_id = ${query.cleanupId}
           AND kind = ${ANNOUNCEMENT_BROADCAST_KIND}
           AND status = ANY(${[...ANNOUNCEMENT_VISIBLE_STATUSES]}::text[])
           ${cursorFilter}
         ORDER BY created_at DESC, id DESC
         LIMIT ${query.limit}`
      return rows.map(toRecord)
    },

    async countAnnouncementsSince(cleanupId: string, since: Date): Promise<number> {
      const rows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM broadcasts
         WHERE cleanup_id = ${cleanupId}
           AND kind = ${ANNOUNCEMENT_BROADCAST_KIND}
           AND status <> 'draft'
           AND created_at >= ${since}`
      return rows[0]?.n ?? 0
    },

    async listAdmin(query: AdminBroadcastListQuery): Promise<AdminBroadcastRow[]> {
      const statusFilter = query.status !== undefined ? sql`AND b.status = ${query.status}` : sql``
      const kindFilter = query.kind !== undefined ? sql`AND b.kind = ${query.kind}` : sql``
      const eventFilter =
        query.cleanupId !== undefined ? sql`AND b.cleanup_id = ${query.cleanupId}` : sql``
      const authorFilter =
        query.createdBy !== undefined ? sql`AND b.created_by = ${query.createdBy}` : sql``
      const fromFilter = query.from !== undefined ? sql`AND b.created_at >= ${query.from}` : sql``
      const toFilter = query.to !== undefined ? sql`AND b.created_at <= ${query.to}` : sql``
      const cursorFilter =
        query.cursor !== null
          ? sql`AND (b.created_at, b.id) < (${query.cursor.createdAt}, ${query.cursor.id})`
          : sql``
      const rows = await sql<
        (BroadcastRowSelect & {
          event_title: string | null
          created_by_name: string | null
          created_by_handle: string | null
          created_by_joined: Date | null
        })[]
      >`
        SELECT b.id, b.cleanup_id, b.created_by, b.kind, b.reminder_offset_min, b.status, b.subject,
               b.body_md, b.cta_label, b.cta_url, b.segment, b.channels, b.reply_to, b.scheduled_at,
               b.planned_at, b.started_at, b.finished_at, b.chunk_size, b.chunk_count,
               b.recipient_count, b.sent_count, b.failed_count, b.suppressed_count,
               b.content_scrubbed_at, b.created_at, b.updated_at,
               c.title AS event_title,
               u.display_name AS created_by_name,
               u.handle AS created_by_handle,
               u.created_at AS created_by_joined
          FROM broadcasts b
          LEFT JOIN cleanups c ON c.id = b.cleanup_id
          LEFT JOIN users u ON u.id = b.created_by
         WHERE true
           ${statusFilter}
           ${kindFilter}
           ${eventFilter}
           ${authorFilter}
           ${fromFilter}
           ${toFilter}
           ${cursorFilter}
         ORDER BY b.created_at DESC, b.id DESC
         LIMIT ${query.limit}`
      return rows.map((row) => ({
        ...toRecord(row),
        eventTitle: row.event_title,
        createdByName: row.created_by_name,
        createdByHandle: row.created_by_handle,
        createdByJoined: row.created_by_joined,
      }))
    },

    async listAdminHosts(params: AdminHostListParams): Promise<AdminHostRow[]> {
      const suspendedFilter =
        params.suspended === undefined
          ? sql``
          : params.suspended
            ? sql`AND COALESCE(m.host_messaging_suspended, false)`
            : sql`AND NOT COALESCE(m.host_messaging_suspended, false)`
      const search =
        params.q !== undefined && params.q.length > 0
          ? sql`AND (u.display_name ILIKE ${`%${params.q}%`} OR u.handle ILIKE ${`%${params.q}%`})`
          : sql``
      const cursorFilter =
        params.cursor !== null
          ? sql`AND (COALESCE(agg.last_broadcast_at, 'epoch'::timestamptz), u.id) < (${params.cursor.at}, ${params.cursor.id}::uuid)`
          : sql``
      const rows = await sql<
        {
          user_id: string
          display_name: string
          handle: string | null
          joined_at: Date | null
          messaging_suspended: boolean
          suspended_at: Date | null
          suspended_by_id: string | null
          suspended_by_name: string | null
          suspended_by_handle: string | null
          suspended_by_joined: Date | null
          broadcast_count: string | number
          recipient_count: string | number
          sent_count: string | number
          failed_count: string | number
          suppressed_count: string | number
          events_messaged: string | number
          last_broadcast_at: Date | null
          sort_at: Date
        }[]
      >`
        WITH agg AS (
          SELECT b.created_by AS user_id,
                 count(*)::int AS broadcast_count,
                 COALESCE(sum(b.recipient_count), 0)::int AS recipient_count,
                 COALESCE(sum(b.sent_count), 0)::int AS sent_count,
                 COALESCE(sum(b.failed_count), 0)::int AS failed_count,
                 COALESCE(sum(b.suppressed_count), 0)::int AS suppressed_count,
                 count(DISTINCT b.cleanup_id)::int AS events_messaged,
                 max(b.created_at) AS last_broadcast_at
            FROM broadcasts b
           WHERE b.created_by IS NOT NULL AND b.created_at >= ${params.windowStart}
           GROUP BY b.created_by
        ), candidates AS (
          SELECT user_id FROM agg
          UNION
          SELECT user_id FROM user_moderation WHERE host_messaging_suspended
        )
        SELECT u.id AS user_id, u.display_name, u.handle, u.created_at AS joined_at,
               COALESCE(m.host_messaging_suspended, false) AS messaging_suspended,
               a.created_at AS suspended_at,
               s.id AS suspended_by_id, s.display_name AS suspended_by_name,
               s.handle AS suspended_by_handle, s.created_at AS suspended_by_joined,
               COALESCE(agg.broadcast_count, 0) AS broadcast_count,
               COALESCE(agg.recipient_count, 0) AS recipient_count,
               COALESCE(agg.sent_count, 0) AS sent_count,
               COALESCE(agg.failed_count, 0) AS failed_count,
               COALESCE(agg.suppressed_count, 0) AS suppressed_count,
               COALESCE(agg.events_messaged, 0) AS events_messaged,
               agg.last_broadcast_at,
               COALESCE(agg.last_broadcast_at, 'epoch'::timestamptz) AS sort_at
          FROM candidates c
          JOIN users u ON u.id = c.user_id AND u.deleted_at IS NULL
          LEFT JOIN agg ON agg.user_id = c.user_id
          LEFT JOIN user_moderation m ON m.user_id = c.user_id
          LEFT JOIN LATERAL (
            SELECT al.created_at, al.actor_id
              FROM audit_log al
             WHERE al.target = 'user:' || u.id::text
               AND al.action IN ('host.messaging_suspended', 'host.messaging_restored')
             ORDER BY al.created_at DESC
             LIMIT 1
          ) a ON COALESCE(m.host_messaging_suspended, false)
          LEFT JOIN users s ON s.id = a.actor_id
         WHERE true
           ${suspendedFilter}
           ${search}
           ${cursorFilter}
         ORDER BY sort_at DESC, u.id DESC
         LIMIT ${params.limit}`
      return rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
        handle: row.handle,
        joinedAt: row.joined_at,
        messagingSuspended: row.messaging_suspended,
        suspendedAt: row.suspended_at,
        suspendedById: row.suspended_by_id,
        suspendedByName: row.suspended_by_name,
        suspendedByHandle: row.suspended_by_handle,
        suspendedByJoined: row.suspended_by_joined,
        broadcastCount: Number(row.broadcast_count),
        recipientCount: Number(row.recipient_count),
        sentCount: Number(row.sent_count),
        failedCount: Number(row.failed_count),
        suppressedCount: Number(row.suppressed_count),
        eventsMessaged: Number(row.events_messaged),
        lastBroadcastAt: row.last_broadcast_at,
        sortAt: row.sort_at,
      }))
    },

    async updateDraft(
      cleanupId: string,
      broadcastId: string,
      patch: BroadcastDraftPatch,
    ): Promise<BroadcastRecord | null> {
      const sets: Array<ReturnType<Sql>> = []
      if (patch.subject !== undefined) sets.push(sql`subject = ${patch.subject}`)
      if (patch.bodyMd !== undefined) sets.push(sql`body_md = ${patch.bodyMd}`)
      if ("ctaLabel" in patch) sets.push(sql`cta_label = ${patch.ctaLabel ?? null}`)
      if ("ctaUrl" in patch) sets.push(sql`cta_url = ${patch.ctaUrl ?? null}`)
      if (patch.segment !== undefined) {
        sets.push(sql`segment = ${jsonParam(sql, patch.segment)}`)
      }
      if (patch.channels !== undefined) sets.push(sql`channels = ${patch.channels}::text[]`)
      const rows = await sql<BroadcastRowSelect[]>`
        UPDATE broadcasts SET ${joinSet(sql, sets)}, updated_at = now()
         WHERE id = ${broadcastId} AND cleanup_id = ${cleanupId} AND status = 'draft'
        RETURNING id, cleanup_id, created_by, kind, reminder_offset_min, status, subject, body_md,
               cta_label, cta_url, segment, channels, reply_to, scheduled_at, planned_at, started_at,
               finished_at, chunk_size, chunk_count, recipient_count, sent_count, failed_count,
               suppressed_count, content_scrubbed_at, created_at, updated_at`
      return rows[0] ? toRecord(rows[0]) : null
    },

    async deleteDraft(cleanupId: string, broadcastId: string): Promise<boolean> {
      const rows = await sql<{ id: string }[]>`
        DELETE FROM broadcasts
         WHERE id = ${broadcastId} AND cleanup_id = ${cleanupId}
           AND status IN ('draft','scheduled') AND planned_at IS NULL
        RETURNING id`
      return rows.length > 0
    },

    async transition(
      broadcastId: string,
      from: readonly BroadcastStatus[],
      to: BroadcastStatus,
      fields = {},
    ): Promise<BroadcastRecord | null> {
      const sets: Array<ReturnType<Sql>> = [sql`status = ${to}`]
      if ("scheduledAt" in fields) sets.push(sql`scheduled_at = ${fields.scheduledAt ?? null}`)
      if ("startedAt" in fields) sets.push(sql`started_at = ${fields.startedAt ?? null}`)
      if ("finishedAt" in fields) sets.push(sql`finished_at = ${fields.finishedAt ?? null}`)
      if ("replyTo" in fields) sets.push(sql`reply_to = ${fields.replyTo ?? null}`)
      const rows = await sql<BroadcastRowSelect[]>`
        UPDATE broadcasts SET ${joinSet(sql, sets)}, updated_at = now()
         WHERE id = ${broadcastId} AND status = ANY(${[...from]}::text[])
        RETURNING id, cleanup_id, created_by, kind, reminder_offset_min, status, subject, body_md,
               cta_label, cta_url, segment, channels, reply_to, scheduled_at, planned_at, started_at,
               finished_at, chunk_size, chunk_count, recipient_count, sent_count, failed_count,
               suppressed_count, content_scrubbed_at, created_at, updated_at`
      return rows[0] ? toRecord(rows[0]) : null
    },

    async markPlanned(
      broadcastId: string,
      args: { recipientCount: number; plannedAt: Date },
    ): Promise<boolean> {
      const rows = await sql<{ id: string }[]>`
        UPDATE broadcasts b
           SET planned_at = ${args.plannedAt},
               recipient_count = ${args.recipientCount},
               chunk_count = (
                 SELECT COALESCE(max(d.chunk_no) + 1, 0)
                   FROM broadcast_deliveries d
                  WHERE d.broadcast_id = b.id),
               updated_at = now()
         WHERE b.id = ${broadcastId} AND b.planned_at IS NULL
        RETURNING b.id`
      return rows.length > 0
    },

    async listStaleSending(staleBefore: Date, limit: number): Promise<string[]> {
      const rows = await sql<{ id: string }[]>`
        SELECT b.id FROM broadcasts b
         WHERE b.status = 'sending' AND b.updated_at < ${staleBefore}
         ORDER BY b.updated_at
         LIMIT ${limit}`
      return rows.map((r) => r.id)
    },

    async listDueScheduled(now: Date, limit: number): Promise<string[]> {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM broadcasts
         WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ${now}
         ORDER BY scheduled_at
         LIMIT ${limit}`
      return rows.map((r) => r.id)
    },

    async insertDeliveries(rows: readonly DeliveryRowInput[]): Promise<number> {
      if (rows.length === 0) return 0
      const broadcastIds = rows.map((r) => r.broadcastId)
      const chunkNos = rows.map((r) => r.chunkNo)
      const kinds = rows.map((r) => r.recipientKind)
      const userIds = rows.map((r) => r.userId)
      const guestIds = rows.map((r) => r.guestId)
      const channels = rows.map((r) => r.channel)
      const inserted = await sql<{ id: string }[]>`
        INSERT INTO broadcast_deliveries (broadcast_id, chunk_no, recipient_kind, user_id, guest_id, channel)
        SELECT t.broadcast_id, t.chunk_no, t.recipient_kind, t.user_id, t.guest_id, t.channel
          FROM unnest(
                 ${broadcastIds}::uuid[], ${chunkNos}::int[], ${kinds}::text[],
                 ${userIds}::uuid[], ${guestIds}::uuid[], ${channels}::text[]
               ) AS t(broadcast_id, chunk_no, recipient_kind, user_id, guest_id, channel)
        ON CONFLICT DO NOTHING
        RETURNING id`
      return inserted.length
    },

    async claimChunk(args: {
      broadcastId: string
      chunkNo: number
      staleBefore: Date
      maxAttempts: number
      limit: number
    }): Promise<DeliveryClaim[]> {
      const rows = await sql<
        {
          id: string
          chunk_no: number
          recipient_kind: BroadcastRecipientKind
          user_id: string | null
          guest_id: string | null
          channel: BroadcastChannel
          attempts: number
        }[]
      >`
        UPDATE broadcast_deliveries d
           SET status = 'in_flight', attempts = d.attempts + 1, updated_at = now()
          FROM (
            SELECT id FROM broadcast_deliveries
             WHERE broadcast_id = ${args.broadcastId}
               AND chunk_no = ${args.chunkNo}
               AND attempts < ${args.maxAttempts}
               AND (status = 'pending' OR (status = 'in_flight' AND updated_at < ${args.staleBefore}))
             ORDER BY id
             FOR UPDATE SKIP LOCKED
             LIMIT ${args.limit}
          ) AS candidate
         WHERE d.id = candidate.id
        RETURNING d.id, d.chunk_no, d.recipient_kind, d.user_id, d.guest_id, d.channel, d.attempts`
      return rows.map((row) => ({
        id: row.id,
        chunkNo: row.chunk_no,
        recipientKind: row.recipient_kind,
        userId: row.user_id,
        guestId: row.guest_id,
        channel: row.channel,
        attempts: row.attempts,
      }))
    },

    async applyDeliveryOutcomes(outcomes: readonly DeliveryOutcome[]): Promise<void> {
      if (outcomes.length === 0) return
      const ids = outcomes.map((o) => o.id)
      const statuses = outcomes.map((o) => o.status)
      const reasons = outcomes.map((o) => o.suppressionReason ?? null)
      const failures = outcomes.map((o) => o.failureKind ?? null)
      const providerIds = outcomes.map((o) => o.providerMessageId ?? null)
      const sentAts = outcomes.map((o) => o.sentAt ?? null)
      await sql`
        UPDATE broadcast_deliveries d
           SET status = t.status,
               suppression_reason = t.suppression_reason,
               failure_kind = t.failure_kind,
               provider_message_id = t.provider_message_id,
               sent_at = t.sent_at,
               updated_at = now()
          FROM unnest(
                 ${ids}::uuid[], ${statuses}::text[], ${reasons}::text[], ${failures}::text[],
                 ${providerIds}::text[], ${sentAts}::timestamptz[]
               ) AS t(id, status, suppression_reason, failure_kind, provider_message_id, sent_at)
         WHERE d.id = t.id`
    },

    async releaseClaims(deliveryIds: readonly string[]): Promise<void> {
      if (deliveryIds.length === 0) return
      await sql`
        UPDATE broadcast_deliveries
           SET status = 'pending',
               attempts = GREATEST(attempts - 1, 0),
               updated_at = now()
         WHERE id = ANY(${[...deliveryIds]}::uuid[])
           AND status IN ('pending','in_flight')`
    },

    async listPendingChunks(broadcastId: string): Promise<number[]> {
      const rows = await sql<{ chunk_no: number }[]>`
        SELECT DISTINCT chunk_no
          FROM broadcast_deliveries
         WHERE broadcast_id = ${broadcastId}
           AND status IN ('pending','in_flight')
         ORDER BY chunk_no`
      return rows.map((row) => row.chunk_no)
    },

    async failExhausted(broadcastId: string, maxAttempts: number): Promise<number> {
      const rows = await sql<{ id: string }[]>`
        UPDATE broadcast_deliveries
           SET status = 'failed', failure_kind = 'unknown', updated_at = now()
         WHERE broadcast_id = ${broadcastId}
           AND status IN ('pending','in_flight')
           AND attempts >= ${maxAttempts}
        RETURNING id`
      return rows.length
    },

    async suppressRemaining(broadcastId: string, reason: string): Promise<number> {
      const rows = await sql<{ id: string }[]>`
        UPDATE broadcast_deliveries
           SET status = 'suppressed', suppression_reason = ${reason}, updated_at = now()
         WHERE broadcast_id = ${broadcastId} AND status IN ('pending','in_flight')
        RETURNING id`
      return rows.length
    },

    async deliveryCounts(broadcastId: string): Promise<DeliveryCounts> {
      const rows = await sql<
        { status: DeliveryStatus; n: string }[]
      >`
        SELECT status, count(*)::text AS n
          FROM broadcast_deliveries
         WHERE broadcast_id = ${broadcastId}
         GROUP BY status`
      const counts: DeliveryCounts = { pending: 0, sent: 0, failed: 0, suppressed: 0, skipped: 0 }
      for (const row of rows) {
        const n = Number(row.n)
        if (row.status === "pending" || row.status === "in_flight") counts.pending += n
        else if (row.status === "sent") counts.sent += n
        else if (row.status === "failed") counts.failed += n
        else if (row.status === "suppressed") counts.suppressed += n
        else counts.skipped += n
      }
      return counts
    },

    async refreshCounts(broadcastId: string): Promise<BroadcastRecord | null> {
      const rows = await sql<BroadcastRowSelect[]>`
        UPDATE broadcasts b
           SET sent_count = c.sent,
               failed_count = c.failed,
               suppressed_count = c.suppressed,
               updated_at = now()
          FROM (
            SELECT count(*) FILTER (WHERE status = 'sent') AS sent,
                   count(*) FILTER (WHERE status = 'failed') AS failed,
                   count(*) FILTER (WHERE status IN ('suppressed','skipped')) AS suppressed
              FROM broadcast_deliveries WHERE broadcast_id = ${broadcastId}
          ) AS c
         WHERE b.id = ${broadcastId}
        RETURNING id, cleanup_id, created_by, kind, reminder_offset_min, status, subject, body_md,
               cta_label, cta_url, segment, channels, reply_to, scheduled_at, planned_at, started_at,
               finished_at, chunk_size, chunk_count, recipient_count, sent_count, failed_count,
               suppressed_count, content_scrubbed_at, created_at, updated_at`
      return rows[0] ? toRecord(rows[0]) : null
    },

    async listDeliveries(query: DeliveryListQuery): Promise<DeliveryListRow[]> {
      const statusFilter = query.status !== undefined ? sql`AND status = ${query.status}` : sql``
      const channelFilter = query.channel !== undefined ? sql`AND channel = ${query.channel}` : sql``
      const cursorFilter =
        query.cursor !== null
          ? sql`AND (created_at, id) < (${query.cursor.createdAt}, ${query.cursor.id})`
          : sql``
      const rows = await sql<
        {
          id: string
          channel: string
          recipient_kind: BroadcastRecipientKind
          status: DeliveryStatus
          suppression_reason: string | null
          failure_kind: string | null
          attempts: number
          sent_at: Date | null
          created_at: Date
        }[]
      >`
        SELECT id, channel, recipient_kind, status, suppression_reason, failure_kind, attempts,
               sent_at, created_at
          FROM broadcast_deliveries
         WHERE broadcast_id = ${query.broadcastId}
           ${statusFilter}
           ${channelFilter}
           ${cursorFilter}
         ORDER BY created_at DESC, id DESC
         LIMIT ${query.limit}`
      return rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        recipientKind: row.recipient_kind,
        status: row.status,
        suppressionReason: row.suppression_reason,
        failureKind: row.failure_kind,
        attempts: row.attempts,
        sentAt: row.sent_at,
        createdAt: row.created_at,
      }))
    },

    async memberContacts(userIds: readonly string[]): Promise<Map<string, MemberContact>> {
      const out = new Map<string, MemberContact>()
      if (userIds.length === 0) return out
      const rows = await sql<
        {
          id: string
          email: string | null
          email_verified_at: Date | null
          display_name: string | null
          locale: string | null
        }[]
      >`
        SELECT id, email, email_verified_at, display_name, locale
          FROM users
         WHERE id = ANY(${[...userIds]}::uuid[]) AND deleted_at IS NULL`
      for (const row of rows) {
        const displayName = row.display_name ?? ""
        out.set(row.id, {
          userId: row.id,
          email: row.email,
          emailVerified: row.email_verified_at !== null,
          displayName,
          firstName: firstName(displayName),
          locale: row.locale,
        })
      }
      return out
    },

    async pushPrefs(userIds: readonly string[]): Promise<Map<string, NotificationPrefsRecord>> {
      const out = new Map<string, NotificationPrefsRecord>()
      if (userIds.length === 0) return out
      const rows = await sql<
        {
          user_id: string
          push: boolean
          cleanup_chat: boolean
          report_updates: boolean
          follows: boolean
          mentions: boolean
          post_interactions: boolean
          host_broadcasts: boolean
          quiet_start: string | null
          quiet_end: string | null
          tz: string | null
        }[]
      >`
        SELECT user_id, push, cleanup_chat, report_updates, follows, mentions, post_interactions,
               host_broadcasts, quiet_start, quiet_end, tz
          FROM notification_prefs
         WHERE user_id = ANY(${[...userIds]}::uuid[])`
      for (const row of rows) {
        out.set(row.user_id, {
          push: row.push,
          cleanupChat: row.cleanup_chat,
          reportUpdates: row.report_updates,
          follows: row.follows,
          mentions: row.mentions,
          postInteractions: row.post_interactions,
          hostBroadcasts: row.host_broadcasts,
          quietStart: row.quiet_start,
          quietEnd: row.quiet_end,
          tz: row.tz,
        })
      }
      return out
    },

    async guestContacts(guestIds: readonly string[]): Promise<Map<string, GuestContact>> {
      const out = new Map<string, GuestContact>()
      if (guestIds.length === 0) return out
      const rows = await sql<{ id: string; email: string | null; name: string }[]>`
        SELECT id, email, name
          FROM cleanup_guests
         WHERE id = ANY(${[...guestIds]}::uuid[])
           AND cancelled_at IS NULL AND contact_scrubbed_at IS NULL`
      for (const row of rows) {
        out.set(row.id, { guestId: row.id, email: row.email, name: row.name })
      }
      return out
    },

    async ticketTypeNames(args: {
      cleanupId: string
      userIds: readonly string[]
      guestIds: readonly string[]
    }): Promise<Map<string, string>> {
      const out = new Map<string, string>()
      if (args.userIds.length === 0 && args.guestIds.length === 0) return out
      const rows = await sql<{ subject_id: string; name: string }[]>`
        SELECT COALESCE(r.user_id, r.guest_id) AS subject_id, t.name
          FROM cleanup_registrations r
          JOIN cleanup_ticket_types t ON t.id = r.ticket_type_id
         WHERE r.cleanup_id = ${args.cleanupId}
           AND r.status = 'registered'
           AND (r.user_id = ANY(${[...args.userIds]}::uuid[])
                OR r.guest_id = ANY(${[...args.guestIds]}::uuid[]))
         ORDER BY r.registered_at DESC`
      for (const row of rows) {
        if (row.subject_id === null) continue
        if (!out.has(row.subject_id)) out.set(row.subject_id, row.name)
      }
      return out
    },

    async eventContext(cleanupId: string): Promise<EventBroadcastContext | null> {
      const rows = await sql<
        {
          id: string
          title: string
          page_slug: string | null
          scheduled_at: Date
          ends_at: Date | null
          timezone: string | null
          address: string | null
          status: string
          organizer_user_id: string
          organization_suspended: boolean
          host_reply_to: string | null
          host_reply_to_verified_at: Date | null
        }[]
      >`
        SELECT c.id, c.title, c.page_slug, c.scheduled_at, c.ends_at, c.timezone, c.address, c.status,
               c.organizer_user_id, c.host_reply_to, c.host_reply_to_verified_at,
               (o.suspended_at IS NOT NULL) AS organization_suspended
          FROM cleanups c
          LEFT JOIN organizations o ON o.id = c.organization_id AND o.deleted_at IS NULL
         WHERE c.id = ${cleanupId}
         LIMIT 1`
      const row = rows[0]
      if (row === undefined) return null
      return {
        cleanupId: row.id,
        title: row.title,
        pageSlug: row.page_slug,
        scheduledAt: row.scheduled_at,
        endsAt: row.ends_at,
        timezone: row.timezone,
        address: row.address,
        status: row.status,
        organizerUserId: row.organizer_user_id,
        organizationSuspended: row.organization_suspended,
        replyTo: row.host_reply_to,
        replyToVerified: row.host_reply_to_verified_at !== null,
      }
    },

    async hostMessagingState(userId: string): Promise<HostMessagingState | null> {
      const rows = await sql<
        { suspended: boolean | null; email_verified_at: Date | null; created_at: Date }[]
      >`
        SELECT um.host_messaging_suspended AS suspended, u.email_verified_at, u.created_at
          FROM users u
          LEFT JOIN user_moderation um ON um.user_id = u.id
         WHERE u.id = ${userId} AND u.deleted_at IS NULL
         LIMIT 1`
      const row = rows[0]
      if (row === undefined) return null
      return {
        suspended: row.suspended === true,
        emailVerified: row.email_verified_at !== null,
        accountCreatedAt: row.created_at,
      }
    },

    async setHostMessagingSuspended(userId: string, suspended: boolean): Promise<boolean> {
      const rows = await sql<{ user_id: string }[]>`
        INSERT INTO user_moderation (user_id, host_messaging_suspended)
        VALUES (${userId}, ${suspended})
        ON CONFLICT (user_id) DO UPDATE
          SET host_messaging_suspended = ${suspended}, updated_at = now()
        RETURNING user_id`
      return rows.length > 0
    },

    async isEmailSuppressed(emailHash: string): Promise<boolean> {
      const rows = await sql<{ email_hash: string }[]>`
        SELECT email_hash FROM email_suppressions WHERE email_hash = ${emailHash} LIMIT 1`
      return rows.length > 0
    },

    async suppressedEmailHashes(emailHashes: readonly string[]): Promise<Set<string>> {
      if (emailHashes.length === 0) return new Set<string>()
      const rows = await sql<{ email_hash: string }[]>`
        SELECT email_hash FROM email_suppressions
         WHERE email_hash = ANY(${[...new Set(emailHashes)]}::text[])`
      return new Set(rows.map((row) => row.email_hash))
    },

    async suppressEmail(
      emailHash: string,
      reason: "hard_bounce" | "complaint" | "manual",
    ): Promise<void> {
      await sql`
        INSERT INTO email_suppressions (email_hash, reason)
        VALUES (${emailHash}, ${reason})
        ON CONFLICT (email_hash) DO UPDATE
          SET hits = email_suppressions.hits + 1, last_at = now()`
    },

    async recordUnsubscribe(args: {
      scope: "event" | "global"
      cleanupId: string | null
      subjectKind: "user" | "guest"
      subjectId: string
      reason: "one_click" | "manual" | "complaint"
    }): Promise<void> {
      await sql`
        INSERT INTO broadcast_unsubscribes (scope, cleanup_id, subject_kind, user_id, guest_id, reason)
        VALUES (
          ${args.scope}, ${args.cleanupId}, ${args.subjectKind},
          ${args.subjectKind === "user" ? args.subjectId : null},
          ${args.subjectKind === "guest" ? args.subjectId : null},
          ${args.reason}
        )
        ON CONFLICT DO NOTHING`
    },

    async setEventMute(cleanupId: string, userId: string, muted: boolean): Promise<void> {
      if (muted) {
        await sql`
          INSERT INTO cleanup_broadcast_mutes (cleanup_id, user_id)
          VALUES (${cleanupId}, ${userId})
          ON CONFLICT DO NOTHING`
        return
      }
      await sql`
        DELETE FROM cleanup_broadcast_mutes
         WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}`
    },

    async isEventMuted(cleanupId: string, userId: string): Promise<boolean> {
      const rows = await sql<{ user_id: string }[]>`
        SELECT user_id FROM cleanup_broadcast_mutes
         WHERE cleanup_id = ${cleanupId} AND user_id = ${userId} LIMIT 1`
      return rows.length > 0
    },

    async listDueReminders(args: {
      now: Date
      staleAfter: Date
      defaultOffsets: readonly number[]
      limit: number
    }): Promise<DueReminder[]> {
      const rows = await sql<{ cleanup_id: string; offset_min: number }[]>`
        SELECT c.id AS cleanup_id, o.offset_min
          FROM cleanups c
          CROSS JOIN LATERAL unnest(
            COALESCE(c.reminder_offsets_min, ${[...args.defaultOffsets]}::int[])
          ) AS o(offset_min)
         WHERE c.status <> 'cancelled'
           AND c.scheduled_at > ${args.now}
           AND c.scheduled_at <= ${args.now} + interval '7 days'
           AND c.scheduled_at - make_interval(mins => o.offset_min) <= ${args.now}
           AND c.scheduled_at - make_interval(mins => o.offset_min) > ${args.staleAfter}
           AND NOT EXISTS (
             SELECT 1 FROM broadcasts b
              WHERE b.cleanup_id = c.id AND b.kind = 'reminder'
                AND b.reminder_offset_min = o.offset_min)
         ORDER BY c.scheduled_at
         LIMIT ${args.limit}`
      return rows.map((row) => ({ cleanupId: row.cleanup_id, offsetMin: row.offset_min }))
    },

    async audiencePage(query: AudiencePageQuery): Promise<{ members: string[]; guests: string[] }> {
      const [members, guests] = await Promise.all([
        listMemberAudiencePage(sql, {
          cleanupId: query.cleanupId,
          segment: query.segment,
          kind: query.kind,
          after: query.afterMember,
          limit: query.limit,
        }),
        listGuestAudiencePage(sql, {
          cleanupId: query.cleanupId,
          segment: query.segment,
          kind: query.kind,
          after: query.afterGuest,
          limit: query.limit,
        }),
      ])
      return { members, guests }
    },

    async scrubBroadcastContent(cutoff: Date, batchSize: number): Promise<number> {
      const rows = await sql<{ id: string }[]>`
        UPDATE broadcasts
           SET body_md = NULL, subject = NULL, cta_label = NULL, cta_url = NULL,
               content_scrubbed_at = now(), updated_at = now()
         WHERE id IN (
           SELECT id FROM broadcasts
            WHERE content_scrubbed_at IS NULL
              AND body_md IS NOT NULL
              AND kind <> ${ANNOUNCEMENT_BROADCAST_KIND}
              AND finished_at IS NOT NULL
              AND finished_at < ${cutoff}
            ORDER BY finished_at
            LIMIT ${batchSize}
         )
        RETURNING id`
      return rows.length
    },

    async deleteOldDeliveries(cutoff: Date, batchSize: number): Promise<number> {
      const rows = await sql<{ id: string }[]>`
        DELETE FROM broadcast_deliveries
         WHERE id IN (
           SELECT id FROM broadcast_deliveries
            WHERE created_at < ${cutoff}
            ORDER BY created_at
            LIMIT ${batchSize}
         )
        RETURNING id`
      return rows.length
    },
  }
}
