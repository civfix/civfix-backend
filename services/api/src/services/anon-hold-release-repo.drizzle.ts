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

    async publishHeldReport(
      reportId: string,
      publishedAt: Date,
      mediaIds: string[] = [],
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        // Lock the report row so the gate re-check + flip are serialized against a concurrent release.
        const locked = await tx<{ id: string }[]>`
          SELECT id FROM reports
          WHERE id = ${reportId} AND status = ${"held"} AND deleted_at IS NULL
          FOR UPDATE
        `
        if (locked.length === 0) return false

        // RE-CHECK the gate inside the tx (closes the read-then-publish TOCTOU): any media that is no
        // longer "ready" blocks publication.
        const notReady = await tx<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM media_assets
          WHERE report_id = ${reportId} AND status <> ${"ready"}
        `
        if ((notReady[0]?.n ?? 0) > 0) return false

        // Any OPEN abuse_flag on the report or one of its media (re-evaluated in-tx) blocks publication.
        const mediaClause =
          mediaIds.length > 0
            ? tx`OR (subject_type = 'media' AND subject_id IN ${tx(mediaIds)})`
            : tx``
        const openFlags = await tx<{ n: number }[]>`
          SELECT COUNT(*)::int AS n
          FROM abuse_flags
          WHERE resolved_at IS NULL
            AND (
              (subject_type = 'report' AND subject_id = ${reportId})
              ${mediaClause}
            )
        `
        if ((openFlags[0]?.n ?? 0) > 0) return false

        await tx`
          UPDATE reports
          SET status = ${"published"}, published_at = ${publishedAt}
          WHERE id = ${reportId} AND status = ${"held"} AND deleted_at IS NULL
        `
        await tx`
          INSERT INTO report_timeline (report_id, status, note, actor_id)
          VALUES (${reportId}, ${"published"}, ${"Released after automated review"}, ${null})
        `
        return true
      })
    },

    async findHeldAnonReportIds(limit: number): Promise<string[]> {
      // Candidate held anon reports for the self-healing release sweep (P2-8). Anon = reporter_user_id
      // IS NULL; held + not deleted. Oldest-first so the longest-stuck reports are reconciled first.
      const rows = await sql<{ id: string }[]>`
        SELECT id
        FROM reports
        WHERE status = ${"held"}
          AND reporter_user_id IS NULL
          AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT ${limit}
      `
      return rows.map((r) => r.id)
    },
  }
}
