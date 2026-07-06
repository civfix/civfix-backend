
import type postgres from "postgres"
import type { ReportCategory } from "@civfix/shared"
import type { Queryable, Sql } from "../../db/client.js"
import { writeAudit } from "./audit.js"
import { decodeCursor, clampLimit } from "./pagination.js"
import { likeContains } from "./like.js"
import {
  type CreateModerationItemInput,
  type ListModerationArgs,
  type ModerationItemRecord,
  type ModerationMediaRecord,
  type ModerationRepository,
  type ModerationUserSnapshot,
} from "./moderation-service.js"

type SqlFragment = postgres.Fragment

const MEDIA_URL_PREFIX = "/media/"

function itemColumns(sql: Queryable): SqlFragment {
  return sql`
    id, kind, subject_type, subject_id, flag, reason, category, place, priority,
    auto_action, status, signals, "similar", meta, created_at
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
  desc: string | null
  user: ModerationUserSnapshot | null
} {
  if (!raw || typeof raw !== "object") return { reporter: null, desc: null, user: null }
  const m = raw as Record<string, unknown>
  const reporter = typeof m.reporter === "string" ? m.reporter : null
  const desc = typeof m.desc === "string" ? m.desc : null
  let user: ModerationUserSnapshot | null = null
  if (m.user && typeof m.user === "object") {
    const u = m.user as Record<string, unknown>
    user = {
      handle: typeof u.handle === "string" ? u.handle : "",
      name: typeof u.name === "string" ? u.name : "Unknown",
      joined: typeof u.joined === "string" ? u.joined : "",
      priorReports: typeof u.priorReports === "number" ? u.priorReports : 0,
      priorRemovals: typeof u.priorRemovals === "number" ? u.priorRemovals : 0,
      strikes: typeof u.strikes === "number" ? u.strikes : 0,
      device: typeof u.device === "string" ? u.device : "",
    }
  }
  return { reporter, desc, user }
}

const CATEGORY_VALUES: readonly string[] = [
  "trash",
  "recycling",
  "graffiti",
  "hazard",
  "encampment",
  "water",
  "other",
]

function toRecord(row: ModerationItemRow, media: ModerationMediaRecord[]): ModerationItemRecord {
  const meta = parseMeta(row.meta)
  const category =
    row.category !== null && CATEGORY_VALUES.includes(row.category)
      ? (row.category as ReportCategory)
      : null
  return {
    id: row.id,
    kind: row.kind,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    flag: row.flag,
    reason: row.reason,
    category,
    place: row.place,
    priority: row.priority,
    autoAction: row.auto_action,
    reporter: meta.reporter,
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
    SELECT id, kind, r2_key, thumb_key
    FROM media_assets
    WHERE report_id = ${subjectId}
    ORDER BY created_at ASC
  `
  return rows.map((m) => ({
    id: m.id,
    kind: m.kind,
    url: MEDIA_URL_PREFIX + m.r2_key,
    thumbUrl: m.thumb_key !== null ? MEDIA_URL_PREFIX + m.thumb_key : null,
  }))
}

export function makeDrizzleModerationRepository(sql: Sql): ModerationRepository {
  return {
    async listOpen(
      args: ListModerationArgs,
    ): Promise<{ records: ModerationItemRecord[]; nextCursor: string | null }> {
      const limit = clampLimit(args.limit)
      const anchor = decodeCursor(args.cursor, true)

      const facet =
        args.filter === "high"
          ? sql`AND priority = 'high'`
          : args.filter !== "all"
            ? sql`AND kind = ${args.filter}`
            : sql``
      const search =
        args.q !== null
          ? (() => {
              const like = likeContains(args.q)
              return sql`AND (
              COALESCE(flag, '') ILIKE ${like} ESCAPE '\\'
              OR COALESCE(meta->>'reporter', '') ILIKE ${like} ESCAPE '\\'
              OR COALESCE(reason, '') ILIKE ${like} ESCAPE '\\'
            )`
            })()
          : sql``
      const keyset = anchor
        ? sql`AND (created_at, id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
        : sql``

      const rows = (await sql`
        SELECT ${itemColumns(sql)}
        FROM moderation_items
        WHERE status = 'open'
        ${facet}
        ${search}
        ${keyset}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `) as unknown as ModerationItemRow[]

      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const records = page.map((r) => toRecord(r, []))
      const last = page[page.length - 1]
      const nextCursor = hasMore && last ? `${last.created_at.toISOString()}|${last.id}` : null
      return { records, nextCursor }
    },

    async getItem(id: string): Promise<ModerationItemRecord | null> {
      const rows = (await sql`
        SELECT ${itemColumns(sql)}
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
        if (resolved.subject_type === "report") {
          const published = await tx<{ id: string }[]>`
            UPDATE reports
            SET status = 'published', published_at = COALESCE(published_at, now())
            WHERE id = ${resolved.subject_id} AND status = 'held' AND deleted_at IS NULL
            RETURNING id
          `
          if (published.length > 0) {
            await tx`
              INSERT INTO report_timeline (report_id, status, note, actor_id)
              VALUES (${resolved.subject_id}, 'published', ${"Approved in moderation"}, ${input.actorId})
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
        return toRecord(resolved, media)
      })
    },

    async remove(
      id: string,
      input: { actorId: string | null; reason: string | null },
    ): Promise<ModerationItemRecord | null> {
      return sql.begin(async (tx) => {
        const resolved = await resolveItem(tx, id, "removed", input.actorId)
        if (!resolved) return null
        const removed = await tombstoneSubject(tx, resolved.subject_type, resolved.subject_id)
        if (removed && resolved.subject_type === "report") {
          await tx`
            INSERT INTO report_timeline (report_id, status, note, actor_id)
            VALUES (${resolved.subject_id}, 'rejected', ${input.reason ?? "Removed in moderation"}, ${input.actorId})
          `
        }
        if (removed) {
          const authorId = await resolveSubjectAuthor(tx, resolved.subject_type, resolved.subject_id)
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
        return toRecord(resolved, media)
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
        if (input.decision === "overturn") {
          await tx`
            UPDATE abuse_flags
            SET resolved_at = now()
            WHERE subject_type = 'chat' AND subject_id = ${resolved.subject_id} AND resolved_at IS NULL
          `
        }
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "moderation.appeal_decided",
          target: `moderation:${id}`,
          meta: { decision: input.decision, subjectId: resolved.subject_id, note: input.note },
        })
        const media = await loadMedia(tx, resolved.subject_type, resolved.subject_id)
        return toRecord(resolved, media)
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
          if (existing[0]) return null
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
            -- L5: derive the kind from the held media instead of hardcoding 'image'. A report with any
            -- media asset is a media hold ('image'; the moderation kind enum has no 'video', so image is
            -- the closest media kind), one without media is a content/behavioral hold ('pattern').
            CASE WHEN EXISTS (SELECT 1 FROM media_assets ma WHERE ma.report_id = r.id)
                 THEN 'image' ELSE 'pattern' END,
            'report', r.id, 'Held report', 'Awaiting automated review', r.category,
            j.name, 'med', 'Hidden pending review', '[]'::jsonb, '[]'::jsonb, 'open',
            jsonb_build_object(
              'reporter', COALESCE(u.display_name, 'Anonymous'),
              'desc', COALESCE(r.description, ''),
              'user', CASE WHEN u.id IS NOT NULL THEN jsonb_build_object(
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

type SubjectType = ModerationItemRecord["subjectType"]

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
      const r = await tx<{ author_user_id: string | null }[]>`
        SELECT author_user_id FROM report_discussion_messages WHERE id = ${subjectId} LIMIT 1`
      return r[0]?.author_user_id ?? null
    }
    case "chat": {
      const r = await tx<{ sender_id: string | null }[]>`
        SELECT sender_id FROM chat_messages WHERE id = ${subjectId} LIMIT 1`
      return r[0]?.sender_id ?? null
    }
    case "message": {
      const r = await tx<{ sender_id: string | null }[]>`
        SELECT sender_id FROM dm_messages WHERE id = ${subjectId} LIMIT 1`
      return r[0]?.sender_id ?? null
    }
    case "event": {
      const r = await tx<{ organizer_user_id: string | null }[]>`
        SELECT organizer_user_id FROM cleanups WHERE id = ${subjectId} LIMIT 1`
      return r[0]?.organizer_user_id ?? null
    }
    case "photo": {
      const r = await tx<{ reporter_user_id: string | null; author_user_id: string | null }[]>`
        SELECT rep.reporter_user_id, d.author_user_id
        FROM media_assets m
        LEFT JOIN reports rep ON rep.id = m.report_id
        LEFT JOIN report_discussion_messages d ON d.id = m.discussion_message_id
        WHERE m.id = ${subjectId} LIMIT 1`
      return r[0]?.reporter_user_id ?? r[0]?.author_user_id ?? null
    }
    default:
      return null
  }
}

async function buildUserSnapshot(
  tx: Queryable,
  userId: string,
): Promise<ModerationUserSnapshot | null> {
  const rows = await tx<
    {
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
    handle: row.handle ?? "",
    name: row.name ?? "Unknown",
    joined: row.joined ?? "",
    priorReports: Number.parseInt(row.prior_reports ?? "0", 10) || 0,
    priorRemovals: row.removals ?? 0,
    strikes: row.strikes ?? 0,
    device: row.device ?? "",
  }
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
      const rows = await tx<{ id: string }[]>`
        UPDATE report_discussion_messages SET deleted_at = now()
        WHERE id = ${subjectId} AND deleted_at IS NULL RETURNING id`
      return rows.length > 0
    }
    case "chat": {
      const rows = await tx<{ id: string }[]>`
        UPDATE chat_messages SET deleted_at = now()
        WHERE id = ${subjectId} AND deleted_at IS NULL RETURNING id`
      return rows.length > 0
    }
    case "message": {
      const rows = await tx<{ id: string }[]>`
        UPDATE dm_messages SET deleted_at = now()
        WHERE id = ${subjectId} AND deleted_at IS NULL RETURNING id`
      return rows.length > 0
    }
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
    case "profile":
    case "user": {
      const rows = await tx<{ user_id: string }[]>`
        INSERT INTO user_moderation (user_id, account_status, flagged, updated_at)
        VALUES (${subjectId}, 'suspended', true, now())
        ON CONFLICT (user_id) DO UPDATE SET account_status = 'suspended', flagged = true, updated_at = now()
        RETURNING user_id`
      return rows.length > 0
    }
    default:
      return false
  }
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
  if (input.desc != null) meta.desc = input.desc
  let userSnapshot = input.user ?? null
  if (userSnapshot == null) {
    const authorId = await resolveSubjectAuthor(tx, input.subjectType, input.subjectId)
    if (authorId != null) userSnapshot = await buildUserSnapshot(tx, authorId)
  }
  if (userSnapshot != null) meta.user = userSnapshot

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
      ${input.priority ?? "med"},
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
