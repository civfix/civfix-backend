import type { ReportCategory } from "@civfix/shared"
import type { Queryable, Sql, SqlFragment } from "../../db/client.js"
import { writeAudit } from "./audit.js"
import {
  clampLimit,
  decodeCursor,
  keysetInstant,
  keysetPredicate,
  paginateKeyset,
} from "./pagination.js"
import { ADMIN_CATEGORIES } from "./category-counts.js"
import { ilikeAnyOf } from "./sql-fragments.js"
import { tombstonePostInTx } from "../post-repository.drizzle.js"
import {
  assertTargetIsNotOfficialAccount,
  assertTargetIsNotOperatorRole,
} from "../../auth/operator-target.js"
import { moderationMediaKeyExpr, moderationMediaFilter } from "../media-served-key.js"
import {
  isMessageSubject,
  isUserSubject,
  MODERATION_APPROVED_NOTE,
  MODERATION_REMOVED_NOTE,
  type CreateModerationItemInput,
  type ListModerationArgs,
  type ModerationItemRecord,
  type ModerationMediaRecord,
  type ModerationRepository,
  type ModerationUserSnapshot,
} from "./moderation-service.js"

type SubjectType = ModerationItemRecord["subjectType"]

const UNKNOWN_USER_NAME = "Unknown"
const DEFAULT_ITEM_PRIORITY = "med"

function itemColumns(sql: Queryable): SqlFragment {
  return sql`
    id, kind, subject_type, subject_id, flag, reason, category, place, priority,
    auto_action, status, signals, "similar", meta, created_at
  `
}

function destinationRefColumn(sql: Queryable): SqlFragment {
  return sql`
    CASE
      WHEN subject_type IN ('chat', 'message') THEN (
        SELECT CASE
          WHEN cm.report_id IS NOT NULL THEN 'report:' || cm.report_id::text
          WHEN cm.cleanup_id IS NOT NULL THEN 'event:' || cm.cleanup_id::text
          ELSE NULL
        END
        FROM chat_messages cm
        WHERE cm.id = moderation_items.subject_id
        LIMIT 1
      )
      WHEN subject_type = 'photo' THEN (
        SELECT CASE
          WHEN COALESCE(ma.report_id, cm.report_id) IS NOT NULL
            THEN 'report:' || COALESCE(ma.report_id, cm.report_id)::text
          WHEN cm.cleanup_id IS NOT NULL THEN 'event:' || cm.cleanup_id::text
          ELSE NULL
        END
        FROM media_assets ma
        LEFT JOIN chat_messages cm ON cm.id = ma.chat_message_id
        WHERE ma.id = moderation_items.subject_id
        LIMIT 1
      )
      ELSE NULL
    END AS destination_ref
  `
}

interface ModerationItemRow {
  id: string
  kind: ModerationItemRecord["kind"]
  subject_type: ModerationItemRecord["subjectType"]
  subject_id: string
  flag: string | null
  reason: string | null
  category: string | null
  place: string | null
  priority: ModerationItemRecord["priority"]
  auto_action: string | null
  status: ModerationItemRecord["status"]
  signals: unknown
  similar: unknown
  meta: unknown
  created_at: Date
  destination_ref?: string | null
}

type Destination = { kind: ModerationItemRecord["destinationKind"]; id: string | null }

const NO_DESTINATION: Destination = { kind: null, id: null }

function resolveDestination(row: ModerationItemRow): Destination {
  switch (row.subject_type) {
    case "report":
      return { kind: "report", id: row.subject_id }
    case "event":
      return { kind: "event", id: row.subject_id }
    case "user":
    case "profile":
      return { kind: "user", id: row.subject_id }
    default:
      return parseDestinationRef(row.destination_ref)
  }
}

function parseDestinationRef(ref: string | null | undefined): Destination {
  if (ref === null || ref === undefined) return NO_DESTINATION
  const sep = ref.indexOf(":")
  if (sep <= 0 || sep === ref.length - 1) return NO_DESTINATION
  const kind = ref.slice(0, sep)
  const id = ref.slice(sep + 1)
  if (kind === "report") return { kind: "report", id }
  if (kind === "event") return { kind: "event", id }
  return NO_DESTINATION
}

function refFor(reportId: string | null, cleanupId: string | null): string | null {
  if (reportId !== null) return `report:${reportId}`
  if (cleanupId !== null) return `event:${cleanupId}`
  return null
}

async function attachDestinationRefs(sql: Queryable, page: ModerationItemRow[]): Promise<void> {
  const chatIds = page.filter((r) => isMessageSubject(r.subject_type)).map((r) => r.subject_id)
  const photoIds = page.filter((r) => r.subject_type === "photo").map((r) => r.subject_id)
  if (chatIds.length === 0 && photoIds.length === 0) return

  const byId = new Map<string, string | null>()
  if (chatIds.length > 0) {
    const rows = await sql<{ id: string; report_id: string | null; cleanup_id: string | null }[]>`
      SELECT id, report_id, cleanup_id FROM chat_messages WHERE id = ANY(${chatIds}::uuid[])
    `
    for (const r of rows) byId.set(r.id, refFor(r.report_id, r.cleanup_id))
  }
  if (photoIds.length > 0) {
    const rows = await sql<{ id: string; report_id: string | null; cleanup_id: string | null }[]>`
      SELECT ma.id,
             COALESCE(ma.report_id, cm.report_id) AS report_id,
             cm.cleanup_id
      FROM media_assets ma
      LEFT JOIN chat_messages cm ON cm.id = ma.chat_message_id
      WHERE ma.id = ANY(${photoIds}::uuid[])
    `
    for (const r of rows) byId.set(r.id, refFor(r.report_id, r.cleanup_id))
  }
  for (const row of page) {
    if (isMessageSubject(row.subject_type) || row.subject_type === "photo") {
      row.destination_ref = byId.get(row.subject_id) ?? null
    }
  }
}

interface MediaRow {
  id: string
  kind: "image" | "video"
  r2_key: string
  thumb_key: string | null
}

function parseSignals(raw: unknown): ModerationItemRecord["signals"] {
  if (!Array.isArray(raw)) return []
  const out: ModerationItemRecord["signals"] = []
  for (const entry of raw) {
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>
      const tone = e.tone
      if (
        typeof e.label === "string" &&
        typeof e.val === "string" &&
        (tone === "ok" || tone === "warn" || tone === "bad")
      ) {
        out.push({ label: e.label, val: e.val, tone })
      }
    }
  }
  return out
}

function parseSimilar(raw: unknown): ModerationItemRecord["similar"] {
  if (!Array.isArray(raw)) return []
  const out: ModerationItemRecord["similar"] = []
  for (const entry of raw) {
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>
      if (typeof e.id === "string" && typeof e.note === "string" && typeof e.when === "string") {
        out.push({ id: e.id, note: e.note, when: e.when })
      }
    }
  }
  return out
}

function parseMeta(raw: unknown): {
  reporter: string | null
  reporterUserId: string | null
  desc: string | null
  user: ModerationUserSnapshot | null
} {
  if (!raw || typeof raw !== "object")
    return { reporter: null, reporterUserId: null, desc: null, user: null }
  const m = raw as Record<string, unknown>
  const reporter = typeof m.reporter === "string" ? m.reporter : null
  const reporterUserId = typeof m.reporterUserId === "string" ? m.reporterUserId : null
  const desc = typeof m.desc === "string" ? m.desc : null
  let user: ModerationUserSnapshot | null = null
  if (m.user && typeof m.user === "object") {
    const u = m.user as Record<string, unknown>
    user = {
      id: typeof u.id === "string" ? u.id : null,
      handle: typeof u.handle === "string" ? u.handle : "",
      name: typeof u.name === "string" ? u.name : UNKNOWN_USER_NAME,
      joined: typeof u.joined === "string" ? u.joined : "",
      priorReports: typeof u.priorReports === "number" ? u.priorReports : 0,
      priorRemovals: typeof u.priorRemovals === "number" ? u.priorRemovals : 0,
      strikes: typeof u.strikes === "number" ? u.strikes : 0,
      device: typeof u.device === "string" ? u.device : "",
    }
  }
  return { reporter, reporterUserId, desc, user }
}

function toRecord(row: ModerationItemRow, media: ModerationMediaRecord[]): ModerationItemRecord {
  const meta = parseMeta(row.meta)
  const category =
    row.category !== null && (ADMIN_CATEGORIES as readonly string[]).includes(row.category)
      ? (row.category as ReportCategory)
      : null
  const destination = resolveDestination(row)
  return {
    id: row.id,
    kind: row.kind,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    destinationKind: destination.kind,
    destinationId: destination.id,
    flag: row.flag,
    reason: row.reason,
    category,
    place: row.place,
    priority: row.priority,
    autoAction: row.auto_action,
    reporter: meta.reporter,
    reporterId: meta.reporterUserId,
    desc: meta.desc,
    status: row.status,
    signals: parseSignals(row.signals),
    similar: parseSimilar(row.similar),
    user: meta.user,
    media,
    createdAt: row.created_at,
  }
}

async function loadMedia(
  sql: Queryable,
  subjectType: string,
  subjectId: string,
): Promise<ModerationMediaRecord[]> {
  if (subjectType !== "report") return []
  const rows = await sql<MediaRow[]>`
    SELECT id, kind, ${moderationMediaKeyExpr(sql, "media_assets")} AS r2_key, thumb_key
    FROM media_assets
    WHERE report_id = ${subjectId}
      AND ${moderationMediaFilter(sql, "media_assets")}
    ORDER BY created_at ASC
  `
  return rows.map((m) => ({
    id: m.id,
    kind: m.kind,
    r2Key: m.r2_key,
    thumbKey: m.thumb_key,
  }))
}

function facetFilter(sql: Queryable, filter: ListModerationArgs["filter"]): SqlFragment {
  if (filter === "high") return sql`AND priority = 'high'`
  if (filter !== "all") return sql`AND kind = ${filter}`
  return sql``
}

function searchFilter(sql: Queryable, q: string | null): SqlFragment {
  if (q === null) return sql``
  return sql`AND ${ilikeAnyOf(
    sql,
    [sql`COALESCE(flag, '')`, sql`COALESCE(meta->>'reporter', '')`, sql`COALESCE(reason, '')`],
    q,
  )}`
}

export function makeDrizzleModerationRepository(sql: Sql): ModerationRepository {
  return {
    async listOpen(
      args: ListModerationArgs,
    ): Promise<{ records: ModerationItemRecord[]; nextCursor: string | null }> {
      const limit = clampLimit(args.limit)
      const anchor = decodeCursor(args.cursor, true)
      const keyset = anchor
        ? sql`AND ${keysetPredicate(sql, sql`created_at`, sql`id`, anchor)}`
        : sql``

      const rows = (await sql`
        SELECT ${itemColumns(sql)}, ${keysetInstant(sql, sql`created_at`)} AS cursor_at
        FROM moderation_items
        WHERE status = 'open'
        ${facetFilter(sql, args.filter)}
        ${searchFilter(sql, args.q)}
        ${keyset}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `) as unknown as (ModerationItemRow & { cursor_at: string })[]

      const { items: page, nextCursor } = paginateKeyset(rows, limit, (r) => ({
        atText: r.cursor_at,
        id: r.id,
      }))
      await attachDestinationRefs(sql, page)
      return { records: page.map((r) => toRecord(r, [])), nextCursor }
    },

    async getItem(id: string): Promise<ModerationItemRecord | null> {
      const rows = (await sql`
        SELECT ${itemColumns(sql)}, ${destinationRefColumn(sql)}
        FROM moderation_items
        WHERE id = ${id}
        LIMIT 1
      `) as unknown as ModerationItemRow[]
      const row = rows[0]
      if (!row) return null
      const media = await loadMedia(sql, row.subject_type, row.subject_id)
      return toRecord(row, media)
    },

    async approve(
      id: string,
      input: { actorId: string | null; note: string | null },
    ): Promise<ModerationItemRecord | null> {
      return sql.begin(async (tx) => {
        const resolved = await resolveItem(tx, id, "approved", input.actorId)
        if (!resolved) return null
        let publishedReport = false
        if (resolved.subject_type === "report") {
          const published = await tx<{ id: string }[]>`
            UPDATE reports
            SET status = 'published', published_at = COALESCE(published_at, now())
            WHERE id = ${resolved.subject_id} AND status = 'held' AND deleted_at IS NULL
            RETURNING id
          `
          if (published.length > 0) {
            publishedReport = true
            await tx`
              INSERT INTO report_timeline (report_id, status, note, actor_id)
              VALUES (${resolved.subject_id}, 'published', ${MODERATION_APPROVED_NOTE}, ${input.actorId})
            `
          }
        }
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "moderation.approved",
          target: `moderation:${id}`,
          meta: {
            subjectType: resolved.subject_type,
            subjectId: resolved.subject_id,
            note: input.note,
          },
        })
        const media = await loadMedia(tx, resolved.subject_type, resolved.subject_id)
        const record = toRecord(resolved, media)
        if (publishedReport) record.reportTimelineStatus = "published"
        return record
      })
    },

    async remove(
      id: string,
      input: { actorId: string | null; reason: string | null },
    ): Promise<ModerationItemRecord | null> {
      return sql.begin(async (tx) => {
        const resolved = await resolveItem(tx, id, "removed", input.actorId)
        if (!resolved) return null
        const userRemoval = isUserSubject(resolved.subject_type)
          ? await removeUserSubject(tx, resolved.subject_id)
          : null
        const removed =
          userRemoval?.removed ??
          (await tombstoneSubject(tx, resolved.subject_type, resolved.subject_id))
        const removedReport = removed && resolved.subject_type === "report"
        if (removedReport) {
          await tx`
            INSERT INTO report_timeline (report_id, status, note, actor_id)
            VALUES (${resolved.subject_id}, 'rejected', ${input.reason ?? MODERATION_REMOVED_NOTE}, ${input.actorId})
          `
        }
        if (removed && !isOwnerTakedown(resolved.meta)) {
          const authorId = await resolveSubjectAuthor(
            tx,
            resolved.subject_type,
            resolved.subject_id,
          )
          if (authorId != null) await incrementUserModeration(tx, authorId)
        }
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "moderation.removed",
          target: `moderation:${id}`,
          meta: {
            subjectType: resolved.subject_type,
            subjectId: resolved.subject_id,
            reason: input.reason,
          },
        })
        const media = await loadMedia(tx, resolved.subject_type, resolved.subject_id)
        const record = toRecord(resolved, media)
        if (removedReport) record.reportTimelineStatus = "rejected"
        if (userRemoval?.suspended === true) record.suspendedUserId = resolved.subject_id
        return record
      })
    },

    async hold(
      id: string,
      input: { actorId: string | null; note: string | null },
    ): Promise<ModerationItemRecord | null> {
      return sql.begin(async (tx) => {
        const resolved = await resolveItem(tx, id, "held", input.actorId)
        if (!resolved) return null
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "moderation.held",
          target: `moderation:${id}`,
          meta: {
            subjectType: resolved.subject_type,
            subjectId: resolved.subject_id,
            note: input.note,
          },
        })
        const media = await loadMedia(tx, resolved.subject_type, resolved.subject_id)
        return toRecord(resolved, media)
      })
    },

    async decideAppeal(
      id: string,
      input: { decision: "uphold" | "overturn"; actorId: string | null; note: string | null },
    ): Promise<ModerationItemRecord | null> {
      return sql.begin(async (tx) => {
        const rows = (await tx`
          UPDATE moderation_items
          SET status = 'approved', resolved_at = now(), resolved_by = ${input.actorId}
          WHERE id = ${id} AND status = 'open' AND kind = 'appeal'
          RETURNING ${itemColumns(tx)}
        `) as unknown as ModerationItemRow[]
        const resolved = rows[0]
        if (!resolved) return null
        let restored = false
        if (input.decision === "overturn") {
          restored = await restoreSubject(tx, resolved.subject_type, resolved.subject_id)
          await tx`
            UPDATE abuse_flags
            SET resolved_at = now()
            WHERE subject_type = ${abuseSubjectTypeFor(resolved.subject_type)}
              AND subject_id = ${resolved.subject_id}
              AND resolved_at IS NULL
          `
        }
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "moderation.appeal_decided",
          target: `moderation:${id}`,
          meta: {
            decision: input.decision,
            subjectId: resolved.subject_id,
            subjectType: resolved.subject_type,
            restored,
            note: input.note,
          },
        })
        const media = await loadMedia(tx, resolved.subject_type, resolved.subject_id)
        const record = toRecord(resolved, media)
        if (restored && isUserSubject(resolved.subject_type)) {
          record.restoredUserId = resolved.subject_id
        }
        return record
      })
    },

    async createItem(input: CreateModerationItemInput): Promise<string | null> {
      return sql.begin(async (tx) => {
        if (input.dedupeOpen) {
          const existing = await tx<{ id: string }[]>`
            SELECT id FROM moderation_items
            WHERE status = 'open'
              AND subject_type = ${input.subjectType}
              AND subject_id = ${input.subjectId}
            LIMIT 1
          `
          if (existing[0]) {
            await escalateOpenItem(tx, existing[0].id, input, await isOwnerRequest(tx, input))
            return null
          }
          return insertModerationItem(tx, input, { dedupeOpen: true })
        }
        return insertModerationItem(tx, input)
      })
    },

    async backfillFromHeldReports(): Promise<number> {
      const rows = await sql<{ count: string }[]>`
        WITH inserted AS (
          INSERT INTO moderation_items (
            kind, subject_type, subject_id, flag, reason, category, place, priority, auto_action,
            signals, "similar", status, meta, created_at
          )
          SELECT
            -- A report with any media asset is a media hold ('image': the moderation kind enum has no
            -- 'video'), one without media is a content/behavioral hold ('pattern').
            CASE WHEN EXISTS (SELECT 1 FROM media_assets ma WHERE ma.report_id = r.id)
                 THEN 'image' ELSE 'pattern' END,
            'report', r.id, 'Held report', 'Awaiting automated review', r.category,
            j.name, 'med', 'Hidden pending review', '[]'::jsonb, '[]'::jsonb, 'open',
            jsonb_build_object(
              'reporter', COALESCE(u.display_name, 'Anonymous'),
              -- For a held report the reporter is the report's own author, so reporterUserId deep-links to
              -- that account (null when anonymous). This is not the subject-author conflation.
              'reporterUserId', u.id::text,
              'desc', COALESCE(r.description, ''),
              'user', CASE WHEN u.id IS NOT NULL THEN jsonb_build_object(
                'id', u.id::text,
                'handle', COALESCE(u.handle::text, ''),
                'name', COALESCE(u.display_name, 'Unknown'),
                'joined', COALESCE(to_char(u.created_at, 'YYYY-MM-DD'), ''),
                'priorReports', (SELECT COUNT(*) FROM reports rr WHERE rr.reporter_user_id = u.id),
                'priorRemovals', COALESCE(um.removals, 0),
                'strikes', COALESCE(um.strikes, 0),
                'device', COALESCE(um.last_device, '')
              ) ELSE NULL END
            ),
            r.created_at
          FROM reports r
          LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
          LEFT JOIN users u ON u.id = r.reporter_user_id
          LEFT JOIN user_moderation um ON um.user_id = u.id
          WHERE r.status = 'held'
            AND r.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM moderation_items mi
              WHERE mi.subject_type = 'report' AND mi.subject_id = r.id AND mi.status = 'open'
            )
          RETURNING id
        )
        SELECT COUNT(*)::text AS count FROM inserted
      `
      return Number(rows[0]?.count ?? "0")
    },
  }
}

async function resolveItem(
  tx: Queryable,
  id: string,
  status: "approved" | "removed" | "held",
  actorId: string | null,
): Promise<ModerationItemRow | null> {
  const rows = (await tx`
    UPDATE moderation_items
    SET status = ${status}, resolved_at = now(), resolved_by = ${actorId}
    WHERE id = ${id} AND status = 'open'
    RETURNING ${itemColumns(tx)}
  `) as unknown as ModerationItemRow[]
  return rows[0] ?? null
}

async function resolveSubjectAuthor(
  tx: Queryable,
  subjectType: SubjectType,
  subjectId: string,
): Promise<string | null> {
  switch (subjectType) {
    case "profile":
    case "user":
      return subjectId
    case "report": {
      const r = await tx<{ reporter_user_id: string | null }[]>`
        SELECT reporter_user_id FROM reports WHERE id = ${subjectId} LIMIT 1`
      return r[0]?.reporter_user_id ?? null
    }
    case "comment": {
      return null
    }
    case "chat": {
      const r = await tx<{ sender_id: string | null }[]>`
        SELECT sender_id FROM chat_messages WHERE id = ${subjectId} LIMIT 1`
      return r[0]?.sender_id ?? null
    }
    case "message":
      return resolveMessageAuthor(tx, subjectId)
    case "event": {
      const r = await tx<{ organizer_user_id: string | null }[]>`
        SELECT organizer_user_id FROM cleanups WHERE id = ${subjectId} LIMIT 1`
      return r[0]?.organizer_user_id ?? null
    }
    case "post": {
      const r = await tx<{ author_id: string | null }[]>`
        SELECT author_id FROM posts WHERE id = ${subjectId} LIMIT 1`
      return r[0]?.author_id ?? null
    }
    case "photo":
      return resolveMediaAuthor(tx, subjectId)
    default:
      return null
  }
}

interface MessageLocation {
  table: "dm_messages" | "chat_messages"
  senderId: string | null
  deletedAt: Date | null
}

async function locateMessage(tx: Queryable, messageId: string): Promise<MessageLocation | null> {
  const rows = await tx<
    {
      source: MessageLocation["table"]
      sender_id: string | null
      deleted_at: Date | null
    }[]
  >`
    SELECT 'dm_messages' AS source, sender_id, deleted_at
      FROM dm_messages WHERE id = ${messageId}
    UNION ALL
    SELECT 'chat_messages' AS source, sender_id, deleted_at
      FROM chat_messages WHERE id = ${messageId}
    LIMIT 1`
  const row = rows[0]
  if (!row) return null
  return { table: row.source, senderId: row.sender_id, deletedAt: row.deleted_at }
}

async function resolveMessageAuthor(tx: Queryable, messageId: string): Promise<string | null> {
  const located = await locateMessage(tx, messageId)
  return located?.senderId ?? null
}

async function resolveMediaAuthor(tx: Queryable, mediaId: string): Promise<string | null> {
  const rows = await tx<{ author_id: string | null }[]>`
    SELECT COALESCE(
      (SELECT dm.sender_id FROM dm_messages dm
        WHERE dm.id = m.chat_message_id
          AND (m.chat_message_created_at IS NULL OR dm.created_at = m.chat_message_created_at)
        LIMIT 1),
      (SELECT cm.sender_id FROM chat_messages cm
        WHERE cm.id = m.chat_message_id
          AND (m.chat_message_created_at IS NULL OR cm.created_at = m.chat_message_created_at)
        LIMIT 1),
      (SELECT p.author_id FROM posts p WHERE p.id = m.post_id),
      (SELECT rep.reporter_user_id FROM reports rep WHERE rep.id = m.report_id),
      (SELECT u.id FROM users u WHERE u.avatar_media_id = m.id ORDER BY u.id LIMIT 1)
    ) AS author_id
    FROM media_assets m
    WHERE m.id = ${mediaId}
    LIMIT 1`
  return rows[0]?.author_id ?? null
}

async function buildUserSnapshot(
  tx: Queryable,
  userId: string,
): Promise<ModerationUserSnapshot | null> {
  const rows = await tx<
    {
      id: string
      handle: string | null
      name: string | null
      joined: string | null
      strikes: number
      removals: number
      device: string | null
      prior_reports: string
    }[]
  >`
    SELECT
      u.id AS id,
      u.handle AS handle,
      u.display_name AS name,
      to_char(u.created_at, 'YYYY-MM-DD') AS joined,
      COALESCE(um.strikes, 0) AS strikes,
      COALESCE(um.removals, 0) AS removals,
      um.last_device AS device,
      (SELECT COUNT(*)::text FROM reports rr WHERE rr.reporter_user_id = u.id) AS prior_reports
    FROM users u
    LEFT JOIN user_moderation um ON um.user_id = u.id
    WHERE u.id = ${userId}
    LIMIT 1`
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    handle: row.handle ?? "",
    name: row.name ?? UNKNOWN_USER_NAME,
    joined: row.joined ?? "",
    priorReports: Number.parseInt(row.prior_reports ?? "0", 10) || 0,
    priorRemovals: row.removals ?? 0,
    strikes: row.strikes ?? 0,
    device: row.device ?? "",
  }
}

function abuseSubjectTypeFor(subjectType: SubjectType): string {
  if (subjectType === "profile") return "user"
  if (subjectType === "photo") return "media"
  return subjectType
}

async function restoreSubject(
  tx: Queryable,
  subjectType: SubjectType,
  subjectId: string,
): Promise<boolean> {
  switch (subjectType) {
    case "chat": {
      const rows = await tx<{ id: string }[]>`
        UPDATE chat_messages SET deleted_at = NULL
        WHERE id = ${subjectId} AND deleted_at IS NOT NULL RETURNING id`
      return rows.length > 0
    }
    case "message":
      return restoreMessage(tx, subjectId)
    case "profile":
    case "user": {
      // Only the 'suspended' a moderation removal imposes is lifted; an operator's separate ban survives.
      const rows = await tx<{ user_id: string }[]>`
        UPDATE user_moderation um
        SET account_status = 'active', flagged = false, updated_at = now()
        FROM users u
        WHERE um.user_id = ${subjectId} AND u.id = um.user_id AND u.deleted_at IS NULL
          AND um.account_status = 'suspended'
        RETURNING um.user_id`
      return rows.length > 0
    }
    default:
      return false
  }
}

async function restoreMessage(tx: Queryable, messageId: string): Promise<boolean> {
  const located = await locateMessage(tx, messageId)
  if (!located || located.deletedAt === null) return false
  const rows =
    located.table === "dm_messages"
      ? await tx<{ id: string }[]>`
          UPDATE dm_messages SET deleted_at = NULL
          WHERE id = ${messageId} AND deleted_at IS NOT NULL RETURNING id`
      : await tx<{ id: string }[]>`
          UPDATE chat_messages SET deleted_at = NULL
          WHERE id = ${messageId} AND deleted_at IS NOT NULL RETURNING id`
  return rows.length > 0
}

async function tombstoneMessage(tx: Queryable, messageId: string): Promise<boolean> {
  const located = await locateMessage(tx, messageId)
  if (!located || located.deletedAt !== null) return false
  const rows =
    located.table === "dm_messages"
      ? await tx<{ id: string }[]>`
          UPDATE dm_messages SET deleted_at = now()
          WHERE id = ${messageId} AND deleted_at IS NULL RETURNING id`
      : await tx<{ id: string }[]>`
          UPDATE chat_messages SET deleted_at = now()
          WHERE id = ${messageId} AND deleted_at IS NULL RETURNING id`
  return rows.length > 0
}

async function tombstoneSubject(
  tx: Queryable,
  subjectType: SubjectType,
  subjectId: string,
): Promise<boolean> {
  switch (subjectType) {
    case "report": {
      const rows = await tx<{ id: string }[]>`
        UPDATE reports SET status = 'rejected', deleted_at = COALESCE(deleted_at, now())
        WHERE id = ${subjectId} AND deleted_at IS NULL RETURNING id`
      return rows.length > 0
    }
    case "comment": {
      return false
    }
    case "chat": {
      const rows = await tx<{ id: string }[]>`
        UPDATE chat_messages SET deleted_at = now()
        WHERE id = ${subjectId} AND deleted_at IS NULL RETURNING id`
      return rows.length > 0
    }
    case "message":
      return tombstoneMessage(tx, subjectId)
    case "photo": {
      const rows = await tx<{ id: string }[]>`
        UPDATE media_assets SET status = 'rejected'
        WHERE id = ${subjectId} AND status <> 'rejected' RETURNING id`
      return rows.length > 0
    }
    case "event": {
      const rows = await tx<{ id: string }[]>`
        UPDATE cleanups SET status = 'cancelled'
        WHERE id = ${subjectId} AND status <> 'cancelled' RETURNING id`
      return rows.length > 0
    }
    case "post": {
      return tombstonePostInTx(tx, subjectId)
    }
    default:
      return false
  }
}

async function removeUserSubject(
  tx: Queryable,
  subjectId: string,
): Promise<{ removed: boolean; suspended: boolean }> {
  assertTargetIsNotOfficialAccount(subjectId, "remove")
  const target = await tx<{ role: string }[]>`
    SELECT role FROM users WHERE id = ${subjectId} AND deleted_at IS NULL FOR NO KEY UPDATE`
  const row = target[0]
  if (row === undefined) return { removed: false, suspended: false }
  assertTargetIsNotOperatorRole(row.role, "remove")
  // A ban outranks the suspension a removal imposes. Overwriting it would also let an appeal overturn,
  // which lifts only suspensions, reactivate a banned account.
  const rows = await tx<{ user_id: string }[]>`
    INSERT INTO user_moderation (user_id, account_status, flagged, updated_at)
    VALUES (${subjectId}, 'suspended', true, now())
    ON CONFLICT (user_id) DO UPDATE SET account_status = 'suspended', flagged = true, updated_at = now()
    WHERE user_moderation.account_status <> 'banned'
    RETURNING user_id`
  return { removed: true, suspended: rows.length > 0 }
}

/**
 * Marks an item that exists only because the report's author asked to take it down. Removing it honors
 * that request, so it must not count as a strike. The marker is set only when the owner's request opens
 * the item and is cleared as soon as any other origin folds in, or an author could pre-file a takedown
 * on every post and wipe the strike an operator would record for a third party's or the pipeline's flag.
 */
const OWNER_TAKEDOWN_META = { ownerTakedown: true } as const

function isOwnerTakedown(meta: unknown): boolean {
  return (
    typeof meta === "object" &&
    meta !== null &&
    (meta as Record<string, unknown>).ownerTakedown === true
  )
}

async function isOwnerRequest(tx: Queryable, input: CreateModerationItemInput): Promise<boolean> {
  if (input.subjectType !== "report" || input.reporterUserId == null) return false
  const authorId = await resolveSubjectAuthor(tx, "report", input.subjectId)
  return authorId !== null && authorId === input.reporterUserId
}

async function escalateOpenItem(
  tx: Queryable,
  itemId: string,
  input: CreateModerationItemInput,
  ownerRequest: boolean,
): Promise<void> {
  const otherOrigin: SqlFragment = ownerRequest ? tx`` : tx`- 'ownerTakedown'`
  await tx`
    UPDATE moderation_items
    SET priority = 'high',
        meta = (CASE
          WHEN ${input.reporterUserId ?? null}::text IS NULL THEN meta
          WHEN meta->'reporters' @> to_jsonb(ARRAY[${input.reporterUserId ?? ""}::text]) THEN meta
          ELSE jsonb_set(
            meta,
            '{reporters}',
            COALESCE(meta->'reporters', '[]'::jsonb) || to_jsonb(${input.reporterUserId ?? ""}::text)
          )
        END) ${otherOrigin}
    WHERE id = ${itemId} AND status = 'open'
  `
}

async function incrementUserModeration(tx: Queryable, userId: string): Promise<void> {
  await tx`
    INSERT INTO user_moderation (user_id, strikes, removals, updated_at)
    VALUES (${userId}, 1, 1, now())
    ON CONFLICT (user_id) DO UPDATE SET
      strikes = user_moderation.strikes + 1,
      removals = user_moderation.removals + 1,
      updated_at = now()`
}

export function insertModerationItem(
  tx: Queryable,
  input: CreateModerationItemInput,
): Promise<string>
export function insertModerationItem(
  tx: Queryable,
  input: CreateModerationItemInput,
  opts: { dedupeOpen: true },
): Promise<string | null>
export async function insertModerationItem(
  tx: Queryable,
  input: CreateModerationItemInput,
  opts: { dedupeOpen?: boolean } = {},
): Promise<string | null> {
  const meta: Record<string, unknown> = {}
  if (input.reporter != null) meta.reporter = input.reporter
  if (input.reporterUserId != null) meta.reporterUserId = input.reporterUserId
  if (input.desc != null) meta.desc = input.desc
  let userSnapshot = input.user ?? null
  if (userSnapshot == null) {
    const authorId = await resolveSubjectAuthor(tx, input.subjectType, input.subjectId)
    if (authorId != null) userSnapshot = await buildUserSnapshot(tx, authorId)
  }
  if (userSnapshot != null) meta.user = userSnapshot
  if (await isOwnerRequest(tx, input)) Object.assign(meta, OWNER_TAKEDOWN_META)

  const onConflict: SqlFragment = opts.dedupeOpen ? tx`ON CONFLICT DO NOTHING` : tx``
  const rows = await tx<{ id: string }[]>`
    INSERT INTO moderation_items (
      kind, subject_type, subject_id, flag, reason, category, place, priority, auto_action,
      signals, "similar", status, meta
    ) VALUES (
      ${input.kind},
      ${input.subjectType},
      ${input.subjectId},
      ${input.flag ?? null},
      ${input.reason ?? null},
      ${input.category ?? null},
      ${input.place ?? null},
      ${input.priority ?? DEFAULT_ITEM_PRIORITY},
      ${input.autoAction ?? null},
      ${tx.json((input.signals ?? []) as Parameters<typeof tx.json>[0])},
      ${tx.json((input.similar ?? []) as Parameters<typeof tx.json>[0])},
      ${"open"},
      ${tx.json(meta as Parameters<typeof tx.json>[0])}
    )
    ${onConflict}
    RETURNING id
  `
  const id = rows[0]?.id
  if (id === undefined) {
    if (opts.dedupeOpen) return null
    throw new Error("insertModerationItem: insert returned no row")
  }
  return id
}
