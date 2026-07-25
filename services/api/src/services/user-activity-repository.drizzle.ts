/**
 * Postgres-backed UserActivityRepository: one keyset-paginated UNION across a user's public,
 * attributable activity sources, newest-first. Written against the raw postgres-js tag (`Sql`).
 *
 * Sources (each a parenthesized leg projecting the SAME columns so UNION ALL aligns):
 *   - created_report   reports the user filed       (the canonical publicReportFilter predicate)
 *   - hosted_event     cleanups they organized      (not cancelled)
 *   - attended_event   cleanups they joined         (as a member, not organizer; not cancelled)
 *   - followed_user    people they followed
 *
 * PRIVACY (intentional exclusions): private messaging NEVER appears in a profile's activity — both DMs
 * (dm_messages) AND group/cleanup chat (chat_messages) are excluded — plus blocks (user_blocks), anon reports
 * (reporter_user_id IS NULL), any report that is not publicly readable (report-sql.ts publicReportFilter —
 * this leg used to spell out its own inverse of that predicate and so admitted `submitted`), cancelled
 * cleanups, and ALL message bodies are never selected — only the public action + a deep-link reference.
 *
 * KEYSET PAGINATION: each leg applies the same `(at, id) < (cursorAt, cursorId)` row-value filter and is
 * bounded to `limit + 1`, then the outer query merges + orders (at DESC, id DESC) + limits `limit + 1`.
 * Filtering each leg by the cursor (rather than only the outer query) is what makes deep paging correct:
 * a leg that contributed nothing to this page is still re-queried (older than the new cursor) next page.
 */

import type { Sql } from "../db/client.js"
import { publicReportFilter } from "./report-sql.js"
import type { CursorAnchor } from "./admin/pagination.js"
import type { UserActivityKind } from "@civfix/shared"
import type { UserActivityRecord, UserActivityRepository } from "./user-activity-service.js"

/** A unioned activity row as selected back (the common projection across all legs). */
interface ActivityRowSelect {
  kind: UserActivityKind
  id: string
  at: Date
  title: string | null
  subtitle: string | null
  ref_kind: "report" | "event" | "person" | null
  ref_id: string | null
}

function toRecord(r: ActivityRowSelect): UserActivityRecord {
  return {
    id: r.id,
    kind: r.kind,
    at: r.at,
    title: r.title,
    subtitle: r.subtitle,
    refKind: r.ref_kind,
    refId: r.ref_id,
  }
}

export function makeDrizzleUserActivityRepository(sql: Sql): UserActivityRepository {
  return {
    async listActivity(args: {
      userId: string
      cursor: CursorAnchor | null
      limit: number
    }): Promise<UserActivityRecord[]> {
      const { userId, cursor } = args
      const lim = args.limit + 1

      // Per-leg keyset condition: each leg orders by (at DESC, id DESC), so the cursor filter compares the
      // leg's own (timestamp, id::text) against the anchor. Empty when there is no cursor (first page).
      const reportCur = cursor
        ? sql`AND (r.created_at, r.id::text) < (${cursor.createdAt}, ${cursor.id})`
        : sql``
      const hostCur = cursor
        ? sql`AND (c.created_at, c.id::text) < (${cursor.createdAt}, ${cursor.id})`
        : sql``
      const joinCur = cursor
        ? sql`AND (m.joined_at, m.cleanup_id::text) < (${cursor.createdAt}, ${cursor.id})`
        : sql``
      const followCur = cursor
        ? sql`AND (fp.created_at, fp.followee_id::text) < (${cursor.createdAt}, ${cursor.id})`
        : sql``

      const rows = await sql<ActivityRowSelect[]>`
        (
          SELECT 'created_report'::text AS kind, r.id::text AS id, r.created_at AS at,
                 ('Reported ' || COALESCE(NULLIF(r.title, ''), r.category)) AS title, r.addr AS subtitle,
                 'report'::text AS ref_kind, r.id::text AS ref_id
          FROM reports r
          WHERE r.reporter_user_id = ${userId}
            AND ${publicReportFilter(sql)}
            ${reportCur}
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT ${lim}
        )
        UNION ALL
        (
          SELECT 'hosted_event'::text AS kind, c.id::text AS id, c.created_at AS at,
                 ('Hosted ' || c.title) AS title, c.address AS subtitle,
                 'event'::text AS ref_kind, c.id::text AS ref_id
          FROM cleanups c
          WHERE c.organizer_user_id = ${userId}
            AND c.status <> 'cancelled'
            ${hostCur}
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT ${lim}
        )
        UNION ALL
        (
          SELECT 'attended_event'::text AS kind, m.cleanup_id::text AS id, m.joined_at AS at,
                 ('Joined ' || c.title) AS title, c.address AS subtitle,
                 'event'::text AS ref_kind, c.id::text AS ref_id
          FROM cleanup_members m
          JOIN cleanups c ON c.id = m.cleanup_id
          WHERE m.user_id = ${userId}
            AND m.role <> 'organizer'
            AND c.status <> 'cancelled'
            ${joinCur}
          ORDER BY m.joined_at DESC, m.cleanup_id DESC
          LIMIT ${lim}
        )
        UNION ALL
        (
          SELECT 'followed_user'::text AS kind, fp.followee_id::text AS id, fp.created_at AS at,
                 ('Followed ' || COALESCE(NULLIF(fu.display_name, ''), '@' || fu.handle)) AS title,
                 ('@' || fu.handle) AS subtitle,
                 'person'::text AS ref_kind, fp.followee_id::text AS ref_id
          FROM follows_people fp
          JOIN users fu ON fu.id = fp.followee_id
          WHERE fp.follower_id = ${userId}
            AND fu.deleted_at IS NULL
            ${followCur}
          ORDER BY fp.created_at DESC, fp.followee_id DESC
          LIMIT ${lim}
        )
        ORDER BY at DESC, id DESC
        LIMIT ${lim}
      `
      return rows.map(toRecord)
    },
  }
}
