import { REPORT_VOLUNTEER_HOURS, avatarGradient } from "@civfix/shared"
import type { LeaderboardEntryDTO, MyVolunteerHoursDTO } from "@civfix/shared"
import type { Sql } from "../db/client.js"
import type {
  LeaderboardPage,
  LogEventHoursArgs,
  VolunteerHoursRepository,
} from "./volunteer-hours-service.js"

export function makeDrizzleVolunteerHoursRepository(sql: Sql): VolunteerHoursRepository {
  return {
    async awardReportHours(userId: string, reportId: string, geoid: string | null): Promise<void> {
      await sql.begin(async (tx) => {
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO volunteer_hours (user_id, hours, source, report_id, jurisdiction_geoid)
          VALUES (${userId}, ${REPORT_VOLUNTEER_HOURS}, 'report', ${reportId}, ${geoid})
          ON CONFLICT (report_id) WHERE source = 'report' DO NOTHING
          RETURNING id
        `
        if (inserted.length === 0) return
        if (geoid === null) return
        await tx`
          INSERT INTO user_jurisdiction_hours (user_id, jurisdiction_geoid, total_hours)
          VALUES (${userId}, ${geoid}, ${REPORT_VOLUNTEER_HOURS})
          ON CONFLICT (user_id, jurisdiction_geoid)
          DO UPDATE SET total_hours = user_jurisdiction_hours.total_hours + EXCLUDED.total_hours
        `
      })
    },

    async logEventHours(args: LogEventHoursArgs): Promise<number> {
      if (args.entries.length === 0) return 0
      // Parallel arrays for the set-based per-row upsert: unnest(uuid[], float8[]) pairs them up
      // positionally, so each attendee gets THEIR OWN hours (WS5 per-attendee shape).
      const userIds = args.entries.map((e) => e.userId)
      const hoursByRow = args.entries.map((e) => e.hours)
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('volunteer_event:' || ${args.cleanupId}))`

        // M21 (history): the upsert below overwrites `hours` in place and overwrites
        // `logged_by_user_id` with it, so before this there was NO record that a value had ever been
        // different — a host could inflate a credit and later restore it invisibly, against a number
        // that feeds the PUBLIC jurisdiction leaderboard. Snapshot the pre-image INSIDE the
        // advisory-locked transaction (so it is exactly what the upsert is about to replace) and append
        // an immutable journal row per credited attendee. NULL previous_hours = no prior credit, which
        // is deliberately distinct from a stored 0.
        //
        // This runs BEFORE the upsert and in the SAME transaction: an audit row written afterwards
        // could be lost to a crash while the mutation committed, which is the one ordering that must
        // never happen for a journal.
        await tx`
          INSERT INTO volunteer_hours_audit
            (cleanup_id, user_id, actor_user_id, previous_hours, new_hours)
          SELECT
            ${args.cleanupId}, t.u, ${args.actorId}, prev.hours, t.h
          FROM unnest(${userIds}::uuid[], ${hoursByRow}::float8[]) AS t(u, h)
          LEFT JOIN volunteer_hours prev
            ON prev.cleanup_id = ${args.cleanupId}
           AND prev.source = 'event'
           AND prev.user_id = t.u
        `

        if (args.geoid === null) {
          const upserted = await tx<{ user_id: string }[]>`
            INSERT INTO volunteer_hours (user_id, hours, source, cleanup_id, jurisdiction_geoid, logged_by_user_id)
            SELECT t.u, t.h, 'event', ${args.cleanupId}, NULL, ${args.actorId}
            FROM unnest(${userIds}::uuid[], ${hoursByRow}::float8[]) AS t(u, h)
            ON CONFLICT (cleanup_id, user_id) WHERE source = 'event'
            DO UPDATE SET hours = EXCLUDED.hours, logged_by_user_id = EXCLUDED.logged_by_user_id
            RETURNING user_id
          `
          return upserted.length
        }
        // Same delta-based rollup maintenance as before, now per row: each attendee's rollup moves by
        // (their new hours - their previous event credit), so a re-log overwrites without double-count.
        const upserted = await tx<{ user_id: string }[]>`
          WITH prev AS (
            SELECT user_id, hours AS old_hours
            FROM volunteer_hours
            WHERE cleanup_id = ${args.cleanupId}
              AND source = 'event'
              AND user_id = ANY(${userIds}::uuid[])
          ),
          upsert AS (
            INSERT INTO volunteer_hours (user_id, hours, source, cleanup_id, jurisdiction_geoid, logged_by_user_id)
            SELECT t.u, t.h, 'event', ${args.cleanupId}, ${args.geoid}, ${args.actorId}
            FROM unnest(${userIds}::uuid[], ${hoursByRow}::float8[]) AS t(u, h)
            ON CONFLICT (cleanup_id, user_id) WHERE source = 'event'
            DO UPDATE SET
              hours = EXCLUDED.hours,
              jurisdiction_geoid = EXCLUDED.jurisdiction_geoid,
              logged_by_user_id = EXCLUDED.logged_by_user_id
            RETURNING user_id, hours
          )
          INSERT INTO user_jurisdiction_hours (user_id, jurisdiction_geoid, total_hours)
          SELECT up.user_id, ${args.geoid}, up.hours - COALESCE(p.old_hours, 0)
          FROM upsert up
          LEFT JOIN prev p ON p.user_id = up.user_id
          ON CONFLICT (user_id, jurisdiction_geoid)
          DO UPDATE SET total_hours = user_jurisdiction_hours.total_hours + EXCLUDED.total_hours
          RETURNING user_id
        `
        return upserted.length
      })
    },

    async totalsFor(userId: string): Promise<MyVolunteerHoursDTO> {
      const rows = await sql<{ geoid: string; name: string | null; hours: number }[]>`
        SELECT
          ujh.jurisdiction_geoid AS geoid,
          j.name AS name,
          ujh.total_hours::float8 AS hours
        FROM user_jurisdiction_hours ujh
        JOIN jurisdictions j ON j.geoid = ujh.jurisdiction_geoid
        WHERE ujh.user_id = ${userId} AND ujh.total_hours > 0
        ORDER BY ujh.total_hours DESC, ujh.jurisdiction_geoid
      `
      const byJurisdiction = rows.map((r) => ({ geoid: r.geoid, name: r.name, hours: r.hours }))
      const totalHours = byJurisdiction.reduce((sum, r) => sum + r.hours, 0)
      return { totalHours, byJurisdiction }
    },

    async totalHoursFor(userId: string): Promise<number> {
      const rows = await sql<{ total: number }[]>`
        SELECT COALESCE(SUM(total_hours), 0)::float8 AS total
        FROM user_jurisdiction_hours
        WHERE user_id = ${userId} AND total_hours > 0
      `
      return rows[0]?.total ?? 0
    },

    async leaderboard(geoid: string, limit: number, offset: number): Promise<LeaderboardPage> {
      const jurRows = await sql<{ name: string }[]>`
        SELECT name FROM jurisdictions WHERE geoid = ${geoid} LIMIT 1
      `
      const jurisdictionName = jurRows[0]?.name ?? null

      const rows = await sql<
        {
          user_id: string
          name: string
          handle: string | null
          avatar_url: string | null
          verified: boolean
          hours: number
        }[]
      >`
        SELECT
          ujh.user_id,
          u.display_name AS name,
          u.handle,
          u.avatar_url,
          EXISTS (
            SELECT 1 FROM user_verification uv
            WHERE uv.user_id = ujh.user_id AND uv.status = 'verified'
          ) AS verified,
          ujh.total_hours::float8 AS hours
        FROM user_jurisdiction_hours ujh
        JOIN users u ON u.id = ujh.user_id
        WHERE ujh.jurisdiction_geoid = ${geoid}
          AND ujh.total_hours > 0
          AND u.deleted_at IS NULL
        ORDER BY ujh.total_hours DESC, ujh.user_id
        LIMIT ${limit + 1} OFFSET ${offset}
      `

      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const entries: LeaderboardEntryDTO[] = page.map((r, i) => ({
        rank: offset + i + 1,
        userId: r.user_id,
        name: r.name,
        ...(r.handle !== null ? { handle: r.handle } : {}),
        avatar: avatarGradient(r.user_id),
        ...(r.avatar_url !== null ? { avatarUrl: r.avatar_url } : {}),
        verified: r.verified,
        hours: r.hours,
      }))

      return {
        jurisdictionName,
        entries,
        nextOffset: hasMore ? offset + limit : null,
      }
    },
  }
}
