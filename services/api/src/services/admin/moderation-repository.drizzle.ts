/**
 * Postgres-backed ModerationRepository (Phase 2): the production binding of the moderation persistence
 * seam.
 *
 * Written against the raw postgres-js tag (`Sql`) rather than the Drizzle query builder because the
 * action methods must run as a SINGLE transaction (transition the moderation_items row AND apply the
 * underlying effect on the subject report/chat AND write the audit, atomically), and because the detail
 * read joins media_assets and parses jsonb that Drizzle does not model cleanly here. Reads/writes touch
 * moderation_items (owned), reports + report_timeline (the report subject effect), media_assets (detail
 * media), abuse_flags (the appeal/suspension subject), and audit_log (via writeAudit).
 *
 * ACTIONS (each one tx, each audited; items clear from the queue because status moves off 'open'):
 *   - approve -> moderation_items.status='approved' (+ resolved_at/by) AND, for a report subject still
 *                held, reports.status held->published + published_at=now + a report_timeline 'published'
 *                row. Audit moderation.approved.
 *   - remove  -> moderation_items.status='removed' (+ resolved_at/by) AND, for a report subject,
 *                reports.status->rejected + deleted_at=now + a report_timeline 'rejected' row. Audit
 *                moderation.removed.
 *   - hold    -> moderation_items.status='held' (+ resolved_at/by); the report stays held (no publish/
 *                reject). Audit moderation.held.
 *   - appeal  -> moderation_items.status='approved' (+ resolved_at/by); overturn resolves the open
 *                abuse_flag for the chat subject (lifts the suspension), uphold leaves it. Audit
 *                moderation.appeal_decided.
 * Every action targets an item WHERE status='open' (the UPDATE returns 0 rows when it is already
 * resolved or missing -> the service 404s / no-ops), so a double-action is a safe no-op.
 *
 * PRODUCER: createItem inserts one open item (optionally deduping against an existing open item for the
 * subject). The standalone insertModerationItem(sql, input) is exported for the media-worker hold path
 * (it is a tiny parameterized INSERT with no service/DI dependency). backfillFromHeldReports creates one
 * item per currently-held report lacking an open item.
 */

import type { ReportCategory } from "@civfix/shared"
import type { Queryable, Sql } from "../../db/client.js"
import { writeAudit } from "./audit.js"
import { decodeCursor, clampLimit } from "./pagination.js"
import {
  type CreateModerationItemInput,
  type ListModerationArgs,
  type ModerationItemRecord,
  type ModerationMediaRecord,
  type ModerationRepository,
  type ModerationUserSnapshot,
} from "./moderation-service.js"

/**
 * R2 public base for moderation media URLs. The moderation detail returns `${MEDIA_URL_PREFIX}<r2_key>`
 * (a relative `/media/...` path the dashboard rewrites via NEXT_PUBLIC_* to the real object-store/CDN
 * origin at render time). NOTE: this DIFFERS from the admin REPORT path, which now SERVER-SIDE presigns
 * its media keys into absolute URLs (admin-report-service.presignMedia over the Storage seam). If
 * moderation media ever needs to render the same way, presign here too rather than relying on the
 * dashboard rewrite.
 */
const MEDIA_URL_PREFIX = "/media/"

/** A moderation_items row (snake_case columns) as read from Postgres. */
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

/** A media_assets row joined for a report subject's detail. */
interface MediaRow {
  id: string
  kind: "image" | "video"
  r2_key: string
  thumb_key: string | null
}

/** Coerce a jsonb signals array into the typed shape, dropping malformed entries. */
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

/** Coerce a jsonb similar array into the typed shape, dropping malformed entries. */
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

/**
 * Parse the user-context snapshot + the row-shaping carry fields out of the item's `meta` jsonb. The
 * producer records `{ reporter, desc, user:{...} }` on meta; reporter/desc are read back for the row +
 * detail, and `user` is the priors/device snapshot. Missing/malformed pieces degrade to null.
 */
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

/** The 6 canonical categories, used to narrow the free-text category column to the typed union. */
const CATEGORY_VALUES: readonly string[] = [
  "trash",
  "recycling",
  "graffiti",
  "hazard",
  "water",
  "other",
]

/** Project a row (+ its media) into the service record. */
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

/** Load the held media references for a report subject (decoded from media_assets). */
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
      const anchor = decodeCursor(args.cursor)

      // Facet: a kind narrows kind; "high" narrows priority; "all" no extra filter.
      const facet =
        args.filter === "high"
          ? sql`AND priority = 'high'`
          : args.filter !== "all"
            ? sql`AND kind = ${args.filter}`
            : sql``
      const search =
        args.q !== null
          ? sql`AND (
              COALESCE(flag, '') ILIKE ${"%" + args.q + "%"}
              OR COALESCE(meta->>'reporter', '') ILIKE ${"%" + args.q + "%"}
              OR COALESCE(reason, '') ILIKE ${"%" + args.q + "%"}
            )`
          : sql``
      // Keyset over (created_at DESC, id DESC): rows strictly before the anchor.
      const keyset = anchor
        ? sql`AND (created_at, id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
        : sql``

      const rows = (await sql`
        SELECT
          id, kind, subject_type, subject_id, flag, reason, category, place, priority,
          auto_action, status, signals, "similar", meta, created_at
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
      // The list rows do not render media (only the detail does), so no media join per row.
      const records = page.map((r) => toRecord(r, []))
      const last = page[page.length - 1]
      const nextCursor = hasMore && last ? `${last.created_at.toISOString()}|${last.id}` : null
      return { records, nextCursor }
    },

    async getItem(id: string): Promise<ModerationItemRecord | null> {
      const rows = (await sql`
        SELECT
          id, kind, subject_type, subject_id, flag, reason, category, place, priority,
          auto_action, status, signals, "similar", meta, created_at
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
        // Underlying effect: publish the held report subject (only when still held).
        if (resolved.subject_type === "report") {
          await tx`
            UPDATE reports
            SET status = 'published', published_at = COALESCE(published_at, now())
            WHERE id = ${resolved.subject_id} AND status = 'held' AND deleted_at IS NULL
          `
          await tx`
            INSERT INTO report_timeline (report_id, status, note, actor_id)
            VALUES (${resolved.subject_id}, 'published', ${"Approved in moderation"}, ${input.actorId})
          `
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
        // Underlying effect: reject + soft-delete the report subject.
        if (resolved.subject_type === "report") {
          await tx`
            UPDATE reports
            SET status = 'rejected', deleted_at = COALESCE(deleted_at, now())
            WHERE id = ${resolved.subject_id} AND deleted_at IS NULL
          `
          await tx`
            INSERT INTO report_timeline (report_id, status, note, actor_id)
            VALUES (${resolved.subject_id}, 'rejected', ${input.reason ?? "Removed in moderation"}, ${input.actorId})
          `
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
        // Hold extends the hold: the report stays held (no publish/reject), the item leaves the queue.
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
        // Only an OPEN appeal-kind item resolves.
        const rows = (await tx`
          UPDATE moderation_items
          SET status = 'approved', resolved_at = now(), resolved_by = ${input.actorId}
          WHERE id = ${id} AND status = 'open' AND kind = 'appeal'
          RETURNING
            id, kind, subject_type, subject_id, flag, reason, category, place, priority,
            auto_action, status, signals, "similar", meta, created_at
        `) as unknown as ModerationItemRow[]
        const resolved = rows[0]
        if (!resolved) return null
        // overturn lifts the suspension by resolving the open abuse_flag for the chat subject; uphold
        // leaves the suspension in place.
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
        }
        return insertModerationItem(tx, input)
      })
    },

    async backfillFromHeldReports(): Promise<number> {
      // One item per currently-held report (status 'held', not deleted) lacking an OPEN item. The INSERT
      // ... SELECT is a single statement so a concurrent backfill cannot double-insert (the NOT EXISTS
      // sees committed open items; the partial-unique-free table tolerates the rare race harmlessly).
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
            jsonb_build_object('reporter', COALESCE(u.display_name, 'Anonymous'), 'desc', COALESCE(r.description, '')),
            r.created_at
          FROM reports r
          LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
          LEFT JOIN users u ON u.id = r.reporter_user_id
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

/**
 * Resolve an OPEN moderation_items row to `status` (setting resolved_at/by) and RETURN the row, or null
 * when it was not open / not found. Shared by approve/remove/hold (decideAppeal has its own kind guard).
 */
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
    RETURNING
      id, kind, subject_type, subject_id, flag, reason, category, place, priority,
      auto_action, status, signals, "similar", meta, created_at
  `) as unknown as ModerationItemRow[]
  return rows[0] ?? null
}

/**
 * Standalone moderation-item INSERT. Exported as the DOCUMENTED producer integration point for the
 * media-worker hold path (see services/media-worker): it has NO service / DI / container dependency, so
 * a producer that already holds a `Queryable` (the worker's repo SQL tag, or an open transaction) can
 * enqueue an item with one call. The API-side producers (anon hold-then-publish, abuse detection) and
 * the in-tx createItem reuse it. `meta` carries the reporter/desc + optional user snapshot for the
 * detail; signals/similar default to empty arrays.
 *
 * Returns the new item id.
 */
export async function insertModerationItem(
  tx: Queryable,
  input: CreateModerationItemInput,
): Promise<string> {
  const meta: Record<string, unknown> = {}
  if (input.reporter != null) meta.reporter = input.reporter
  if (input.desc != null) meta.desc = input.desc
  if (input.user != null) meta.user = input.user

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
    RETURNING id
  `
  const id = rows[0]?.id
  if (id === undefined) throw new Error("insertModerationItem: insert returned no row")
  return id
}
