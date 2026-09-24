import type { Queryable, Sql } from "../db/client.js"
import type { AnonHoldReleaseRepo, HeldReportView, ReleaseMediaView } from "./anon-hold-release.js"

const RELEASE_TIMELINE_NOTE = "Released after automated review"

async function countOpenFlags(
  tag: Queryable,
  reportId: string,
  mediaIds: string[],
): Promise<number> {
  const mediaClause =
    mediaIds.length > 0
      ? tag`OR (subject_type = 'media' AND subject_id IN ${tag(mediaIds)})`
      : tag``
  const rows = await tag<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM abuse_flags
    WHERE resolved_at IS NULL
      AND (
        (subject_type = 'report' AND subject_id = ${reportId})
        ${mediaClause}
      )
  `
  return rows[0]?.n ?? 0
}

export function makeDrizzleAnonHoldReleaseRepo(sql: Sql): AnonHoldReleaseRepo {
  return {
    async findReport(reportId: string): Promise<HeldReportView | null> {
      const rows = await sql<
        {
          id: string
          reporter_user_id: string | null
          anon_session_id: string | null
          status: string
          visibility: string
          lng: number
          lat: number
          deleted_at: Date | null
        }[]
      >`
        SELECT id, reporter_user_id, anon_session_id, status, visibility,
               ST_X(geom) AS lng, ST_Y(geom) AS lat, deleted_at
        FROM reports WHERE id = ${reportId} LIMIT 1
      `
      const r = rows[0]
      if (!r) return null
      return {
        id: r.id,
        reporterUserId: r.reporter_user_id,
        anonSessionId: r.anon_session_id,
        status: r.status,
        visibility: r.visibility,
        lat: r.lat,
        lng: r.lng,
        deletedAt: r.deleted_at,
      }
    },

    async findMedia(reportId: string): Promise<ReleaseMediaView[]> {
      const rows = await sql<
        { id: string; status: "validating" | "ready" | "rejected" | "held" }[]
      >`
        SELECT id, status FROM media_assets WHERE report_id = ${reportId}
      `
      return rows.map((m) => ({ id: m.id, status: m.status }))
    },

    countOpenAbuseFlags(reportId: string, mediaIds: string[]): Promise<number> {
      return countOpenFlags(sql, reportId, mediaIds)
    },

    async publishHeldReport(
      reportId: string,
      publishedAt: Date,
      mediaIds: string[] = [],
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const locked = await tx<{ id: string }[]>`
          SELECT id FROM reports
          WHERE id = ${reportId} AND status = ${"held"} AND deleted_at IS NULL
          FOR UPDATE
        `
        if (locked.length === 0) return false

        const notReady = await tx<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM media_assets
          WHERE report_id = ${reportId} AND status <> ${"ready"}
        `
        if ((notReady[0]?.n ?? 0) > 0) return false

        if ((await countOpenFlags(tx, reportId, mediaIds)) > 0) return false

        await tx`
          UPDATE reports
          SET status = ${"published"}, published_at = ${publishedAt}
          WHERE id = ${reportId} AND status = ${"held"} AND deleted_at IS NULL
        `
        await tx`
          INSERT INTO report_timeline (report_id, status, note, actor_id)
          VALUES (${reportId}, ${"published"}, ${RELEASE_TIMELINE_NOTE}, ${null})
        `
        await tx`
          UPDATE moderation_items
          SET status = ${"approved"}, resolved_at = ${publishedAt}, resolved_by = ${null}
          WHERE subject_type = 'report' AND subject_id = ${reportId} AND status = 'open'
        `
        return true
      })
    },

    async findHeldAnonReportIds(limit: number): Promise<string[]> {
      const rows = await sql<{ id: string }[]>`
        UPDATE reports
        SET hold_release_checked_at = now()
        WHERE id IN (
          SELECT id
          FROM reports
          WHERE status = ${"held"}
            AND anon_session_id IS NOT NULL
            AND deleted_at IS NULL
          ORDER BY hold_release_checked_at ASC NULLS FIRST, created_at ASC
          LIMIT ${limit}
        )
        RETURNING id
      `
      return rows.map((r) => r.id)
    },
  }
}
