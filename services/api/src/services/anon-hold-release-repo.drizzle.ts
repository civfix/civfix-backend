/**
 * Postgres-backed AnonHoldReleaseRepo (the media-worker's hold-release gate).
 *
 * Lives in its OWN file (separate from anon-repository.drizzle.ts) so the media-worker can import just
 * the release repo + the release function without pulling in the anon SUBMIT service (Turnstile/abuse
 * token/auth crypto), keeping the worker's bundle and seam surface minimal. Reads the report (with geom
 * decoded), its media statuses, and the open-abuse-flag count, then flips held -> published in one
 * transaction. Uses the raw postgres-js tag because of the PostGIS geometry read.
 */

import type { Sql } from "../db/client.js"
import type {
  AnonHoldReleaseRepo,
  HeldReportView,
  ReleaseMediaView,
} from "./anon-hold-release.js"

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
      // NOTE: EXIF GPS is not persisted on media_assets (the worker strips location for privacy and
      // does not store the original fix), so exifGeo is omitted here. The release gate treats "no EXIF
      // signal" as passing; if a future column lands, surface it here to enable the cross-check.
      const rows = await sql<
        { id: string; status: "validating" | "ready" | "rejected" | "held" }[]
      >`
        SELECT id, status FROM media_assets WHERE report_id = ${reportId}
      `
      return rows.map((m) => ({ id: m.id, status: m.status }))
    },

    async countOpenAbuseFlags(reportId: string, mediaIds: string[]): Promise<number> {
      // Open (unresolved) flags whose subject is the report itself, OR (when it has media) any of its
      // media. subject_id is text. The media clause is only added when there are media ids so the IN
      // list is never empty.
      const mediaClause =
        mediaIds.length > 0
          ? sql`OR (subject_type = 'media' AND subject_id IN ${sql(mediaIds)})`
          : sql``
      const rows = await sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n
        FROM abuse_flags
        WHERE resolved_at IS NULL
          AND (
            (subject_type = 'report' AND subject_id = ${reportId})
            ${mediaClause}
          )
      `
      return rows[0]?.n ?? 0
    },

    async publishHeldReport(reportId: string, publishedAt: Date): Promise<boolean> {
      return sql.begin(async (tx) => {
        // Flip only while still held (idempotent under a concurrent release).
        const updated = await tx<{ id: string }[]>`
          UPDATE reports
          SET status = ${"published"}, published_at = ${publishedAt}
          WHERE id = ${reportId} AND status = ${"held"} AND deleted_at IS NULL
          RETURNING id
        `
        if (updated.length === 0) return false
        await tx`
          INSERT INTO report_timeline (report_id, status, note, actor_id)
          VALUES (${reportId}, ${"published"}, ${"Released after automated review"}, ${null})
        `
        return true
      })
    },
  }
}
