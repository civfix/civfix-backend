/**
 * Postgres-backed ActivityRepository (Phase 2): the merged recent-activity feed (#6, enumeration 4.9).
 *
 * ONE union query across the four sources, newest-first, capped at `limit`:
 *   - audit_log    (operator / gov actions) -> source 'audit'   (action + actor name + target)
 *   - reports      (a citizen dropped a pin) -> source 'report' (category subject + jurisdiction place +
 *                  reporter name); only PUBLIC, non-deleted reports (we do not leak held/hidden ones)
 *   - cleanups     (a cleanup was planned)   -> source 'cleanup' (title subject + organizer name)
 *   - mail_events  (delivery events)         -> source 'mail_event' (type + thread org/jurisdiction)
 *
 * Each branch projects the SAME column set so the UNION ALL aligns; the outer query orders by ts DESC and
 * limits. To bound the per-source scan (and keep the union cheap) each branch is itself limited to `limit`
 * before the union (a source can contribute at most `limit` rows, which is sufficient since the final cut
 * is also `limit`). Written against the raw postgres-js tag like the other admin repos.
 *
 * The service does the kind/hue/what classification; this repo only NORMALIZES the rows.
 */

import type { Sql } from "../../db/client.js"
import { clampLimit } from "./pagination.js"
import type { ActivityRepository, ActivitySourceRecord, ActivitySource } from "./activity-service.js"

/** A unioned activity row as selected back (snake_case; the common projection across all sources). */
interface ActivityRowSelect {
  source: ActivitySource
  id: string
  ts: Date
  who: string | null
  where_label: string | null
  action: string | null
  event_type: string | null
  subject: string | null
}

function toRecord(r: ActivityRowSelect): ActivitySourceRecord {
  return {
    source: r.source,
    id: r.id,
    ts: r.ts,
    who: r.who ?? "",
    where: r.where_label ?? "",
    action: r.action,
    eventType: r.event_type,
    subject: r.subject,
  }
}

/** Construct the production ActivityRepository over the raw postgres-js tag (`container.getDb().sql`). */
export function makeDrizzleActivityRepository(sql: Sql): ActivityRepository {
  return {
    async recent(limit: number): Promise<ActivitySourceRecord[]> {
      const n = clampLimit(limit)
      // Each branch projects (source, id, ts, who, where_label, action, event_type, subject) and is
      // per-source limited to `n` so the union scans at most 4*n rows before the final ORDER BY/LIMIT.
      const rows = await sql<ActivityRowSelect[]>`
        (
          SELECT 'audit'::text AS source, a.id::text AS id, a.created_at AS ts,
                 u.display_name AS who, a.target AS where_label,
                 a.action AS action, NULL::text AS event_type, a.target AS subject
          FROM audit_log a
          LEFT JOIN users u ON u.id = a.actor_id
          ORDER BY a.created_at DESC
          LIMIT ${n}
        )
        UNION ALL
        (
          SELECT 'report'::text AS source, r.id::text AS id, r.created_at AS ts,
                 ru.display_name AS who, j.name AS where_label,
                 NULL::text AS action, NULL::text AS event_type, r.category AS subject
          FROM reports r
          LEFT JOIN users ru ON ru.id = r.reporter_user_id
          LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
          WHERE r.deleted_at IS NULL AND r.visibility = 'public'
          -- reports.created_at is DEFAULT now() (effectively non-null on every row), so the COALESCE
          -- fallback never fires; ordering on the bare column lets the (created_at DESC) index serve
          -- the sort instead of a seq-scan+top-N heap sort. Output order is identical.
          ORDER BY r.created_at DESC
          LIMIT ${n}
        )
        UNION ALL
        (
          SELECT 'cleanup'::text AS source, c.id::text AS id, c.created_at AS ts,
                 cu.display_name AS who, c.address AS where_label,
                 NULL::text AS action, NULL::text AS event_type, c.title AS subject
          FROM cleanups c
          LEFT JOIN users cu ON cu.id = c.organizer_user_id
          -- cleanups.created_at is DEFAULT now() (set on insert, effectively non-null), so the COALESCE
          -- fallback to scheduled_at never fires; ordering on the bare column lets the (created_at DESC)
          -- index serve the sort instead of a seq-scan+top-N heap sort. Output order is identical.
          ORDER BY c.created_at DESC
          LIMIT ${n}
        )
        UNION ALL
        (
          SELECT 'mail_event'::text AS source, e.id::text AS id, e.created_at AS ts,
                 t.org AS who, COALESCE(t.org, t.jurisdiction_geoid) AS where_label,
                 NULL::text AS action, e.type AS event_type, t.subject AS subject
          FROM mail_events e
          LEFT JOIN mail_threads t ON t.id = e.thread_id
          ORDER BY e.created_at DESC
          LIMIT ${n}
        )
        ORDER BY ts DESC
        LIMIT ${n}
      `
      return rows.map(toRecord)
    },
  }
}
