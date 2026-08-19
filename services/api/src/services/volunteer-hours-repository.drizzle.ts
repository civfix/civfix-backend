import { avatarGradient } from "@civfix/shared"
import type { LeaderboardEntryDTO, MyVolunteerHoursDTO, VolunteerHoursSource } from "@civfix/shared"
import type { Sql } from "../db/client.js"
import { encodeTimeCursor, pageWith } from "../db/cursor-helpers.js"
import { blockedPairExpr, hiddenIdentity } from "./hidden-identity.js"
import { EVENT_HOURS_MEMBER_CAP, ITEMISED_SOURCES } from "./volunteer-hours-service.js"
import type {
  CertificateEntriesPage,
  EntriesForCertificateArgs,
  EventHoursLedger,
  HoursVisibility,
  LeaderboardPage,
  ListEntriesArgs,
  LogEventHoursArgs,
  LogEventHoursResult,
  VolunteerHoursEntryView,
  VolunteerHoursRepository,
} from "./volunteer-hours-service.js"

const MORE_PAGES = "more"

interface LedgerRow {
  id: string
  source: VolunteerHoursSource
  hours: number
  created_at: Date
  scheduled_at: Date | null
  cleanup_id: string | null
  cleanup_title: string | null
  reference_code: string | null
  report_id: string | null
  jurisdiction_geoid: string | null
  jurisdiction_name: string | null
  creditor_id: string | null
  creditor_name: string | null
  creditor_handle: string | null
  creditor_verified: boolean | null
}

function toEntryView(r: LedgerRow): VolunteerHoursEntryView {
  return {
    id: r.id,
    source: r.source,
    hours: r.hours,
    createdAt: r.created_at,
    occurredAt: r.scheduled_at ?? r.created_at,
    cleanupId: r.cleanup_id,
    cleanupTitle: r.cleanup_title,
    cleanupReferenceCode: r.reference_code,
    reportId: r.report_id,
    jurisdictionGeoid: r.jurisdiction_geoid,
    jurisdictionName: r.jurisdiction_name,
    creditedBy:
      r.creditor_id !== null
        ? {
            id: r.creditor_id,
            name: r.creditor_name ?? "",
            handle: r.creditor_handle,
            verified: r.creditor_verified ?? false,
          }
        : null,
  }
}

async function computeTotalHours(sql: Sql, userId: string): Promise<number> {
  const rows = await sql<{ total: number }[]>`
    SELECT (
      (SELECT COALESCE(SUM(total_hours), 0)
         FROM user_jurisdiction_hours
        WHERE user_id = ${userId} AND total_hours > 0)
      + (SELECT COALESCE(SUM(hours), 0)
           FROM volunteer_hours
          WHERE user_id = ${userId} AND voided_at IS NULL
            AND source <> 'report' AND jurisdiction_geoid IS NULL)
    )::float8 AS total
  `
  return Math.round((rows[0]?.total ?? 0) * 100) / 100
}

export function makeDrizzleVolunteerHoursRepository(sql: Sql): VolunteerHoursRepository {
  return {
    async logEventHours(args: LogEventHoursArgs): Promise<LogEventHoursResult> {
      if (args.entries.length === 0) return { credited: 0, changed: [] }
      const userIds = args.entries.map((e) => e.userId)
      const hoursByRow = args.entries.map((e) => e.hours)
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('volunteer_event:' || ${args.cleanupId}))`

        const audit = await tx<
          { user_id: string; previous_hours: number | null; new_hours: number }[]
        >`
          INSERT INTO volunteer_hours_audit
            (cleanup_id, user_id, actor_user_id, previous_hours, new_hours)
          SELECT
            ${args.cleanupId}, t.u, ${args.actorId}, prev.hours, t.h
          FROM unnest(${userIds}::uuid[], ${hoursByRow}::float8[]) AS t(u, h)
          LEFT JOIN volunteer_hours prev
            ON prev.cleanup_id = ${args.cleanupId}
           AND prev.source = 'event'
           AND prev.user_id = t.u
          RETURNING
            user_id,
            previous_hours::float8 AS previous_hours,
            new_hours::float8 AS new_hours
        `
        const changed = audit.map((r) => ({
          userId: r.user_id,
          hours: r.new_hours,
          previousHours: r.previous_hours,
        }))

        if (args.geoid === null) {
          const upserted = await tx<{ user_id: string }[]>`
            WITH prev AS (
              SELECT user_id, hours AS old_hours, jurisdiction_geoid AS old_geoid
              FROM volunteer_hours
              WHERE cleanup_id = ${args.cleanupId}
                AND source = 'event'
                AND user_id = ANY(${userIds}::uuid[])
            ),
            upsert AS (
              INSERT INTO volunteer_hours (user_id, hours, source, cleanup_id, jurisdiction_geoid, logged_by_user_id)
              SELECT t.u, t.h, 'event', ${args.cleanupId}, NULL, ${args.actorId}
              FROM unnest(${userIds}::uuid[], ${hoursByRow}::float8[]) AS t(u, h)
              ON CONFLICT (cleanup_id, user_id) WHERE source = 'event'
              DO UPDATE SET
                hours = EXCLUDED.hours,
                jurisdiction_geoid = EXCLUDED.jurisdiction_geoid,
                logged_by_user_id = EXCLUDED.logged_by_user_id
              RETURNING user_id
            ),
            reversal AS (
              INSERT INTO user_jurisdiction_hours (user_id, jurisdiction_geoid, total_hours)
              SELECT p.user_id, p.old_geoid, -p.old_hours
              FROM upsert up
              JOIN prev p ON p.user_id = up.user_id
              WHERE p.old_geoid IS NOT NULL
              ON CONFLICT (user_id, jurisdiction_geoid)
              DO UPDATE SET total_hours = user_jurisdiction_hours.total_hours + EXCLUDED.total_hours
              RETURNING user_id
            )
            SELECT user_id FROM upsert
          `
          return { credited: upserted.length, changed }
        }
        const upserted = await tx<{ user_id: string }[]>`
          WITH prev AS (
            SELECT user_id, hours AS old_hours, jurisdiction_geoid AS old_geoid
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
          ),
          deltas AS (
            SELECT
              up.user_id,
              ${args.geoid}::text AS geoid,
              up.hours - COALESCE(
                CASE WHEN p.old_geoid = ${args.geoid} THEN p.old_hours END, 0
              ) AS delta
            FROM upsert up
            LEFT JOIN prev p ON p.user_id = up.user_id
            UNION ALL
            -- The event moved jurisdictions since this attendee was last credited: take the stale hours
            -- back out of the jurisdiction it no longer belongs to. Disjoint from the branch above (that
            -- one is always the CURRENT geoid), so no (user, geoid) pair is inserted twice.
            SELECT p.user_id, p.old_geoid, -p.old_hours
            FROM upsert up
            JOIN prev p ON p.user_id = up.user_id
            WHERE p.old_geoid IS NOT NULL AND p.old_geoid <> ${args.geoid}
          )
          INSERT INTO user_jurisdiction_hours (user_id, jurisdiction_geoid, total_hours)
          SELECT d.user_id, d.geoid, d.delta FROM deltas d
          ON CONFLICT (user_id, jurisdiction_geoid)
          DO UPDATE SET total_hours = user_jurisdiction_hours.total_hours + EXCLUDED.total_hours
          RETURNING user_id
        `
        return { credited: new Set(upserted.map((r) => r.user_id)).size, changed }
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
      const totalHours = await computeTotalHours(sql, userId)
      return { totalHours, byJurisdiction }
    },

    async totalHoursFor(userId: string): Promise<number> {
      return computeTotalHours(sql, userId)
    },

    async leaderboard(
      geoid: string,
      limit: number,
      offset: number,
      viewerId: string | null,
      withExtras: boolean,
    ): Promise<LeaderboardPage> {
      const jurRows = await sql<{ name: string }[]>`
        SELECT name FROM jurisdictions WHERE geoid = ${geoid} LIMIT 1
      `
      const jurisdictionName = jurRows[0]?.name ?? null

      const blockedPair = blockedPairExpr(sql, viewerId, sql`ujh.user_id`)

      const rows = await sql<
        {
          user_id: string
          name: string
          handle: string | null
          avatar_url: string | null
          verified: boolean
          hours: number
          blocked_pair: boolean
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
          ${blockedPair} AS blocked_pair,
          ujh.total_hours::float8 AS hours
        FROM user_jurisdiction_hours ujh
        JOIN users u ON u.id = ujh.user_id
        WHERE ujh.jurisdiction_geoid = ${geoid}
          AND ujh.total_hours > 0
          AND u.deleted_at IS NULL
          AND u.show_volunteer_hours IS NOT FALSE
        ORDER BY ujh.total_hours DESC, ujh.user_id
        LIMIT ${limit + 1} OFFSET ${offset}
      `

      let viewerRank: number | null = null
      let viewerHours: number | null = null
      if (withExtras && viewerId !== null) {
        const meRows = await sql<{ hours: number | null; rank: number | null }[]>`
          WITH me AS (
            SELECT ujh.total_hours
            FROM user_jurisdiction_hours ujh
            JOIN users u ON u.id = ujh.user_id
            WHERE ujh.user_id = ${viewerId}
              AND ujh.jurisdiction_geoid = ${geoid}
              AND ujh.total_hours > 0
              AND u.deleted_at IS NULL
              AND u.show_volunteer_hours IS NOT FALSE
          )
          SELECT
            (SELECT total_hours::float8 FROM me) AS hours,
            CASE WHEN EXISTS (SELECT 1 FROM me) THEN (
              SELECT count(*)::int + 1
              FROM user_jurisdiction_hours o
              JOIN users ou ON ou.id = o.user_id
              WHERE o.jurisdiction_geoid = ${geoid}
                AND o.total_hours > (SELECT total_hours FROM me)
                AND o.total_hours > 0
                AND ou.deleted_at IS NULL
                AND ou.show_volunteer_hours IS NOT FALSE
            ) END AS rank
        `
        viewerHours = meRows[0]?.hours ?? null
        viewerRank = meRows[0]?.rank ?? null
      }

      let participantCount: number | null = null
      if (withExtras && offset === 0) {
        const countRows = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM user_jurisdiction_hours ujh
          JOIN users u ON u.id = ujh.user_id
          WHERE ujh.jurisdiction_geoid = ${geoid}
            AND ujh.total_hours > 0
            AND u.deleted_at IS NULL
            AND u.show_volunteer_hours IS NOT FALSE
        `
        participantCount = countRows[0]?.count ?? 0
      }

      const { items: page, nextCursor: more } = pageWith(rows, limit, () => MORE_PAGES)
      const entries: LeaderboardEntryDTO[] = page.map((r, i) => {
        const rankAndHours = { rank: offset + i + 1, userId: r.user_id, hours: r.hours }
        if (r.blocked_pair) {
          const hidden = hiddenIdentity(r.user_id)
          return { ...rankAndHours, name: hidden.name, avatar: hidden.avatar, verified: false }
        }
        return {
          ...rankAndHours,
          name: r.name,
          ...(r.handle !== null ? { handle: r.handle } : {}),
          avatar: avatarGradient(r.user_id),
          ...(r.avatar_url !== null ? { avatarUrl: r.avatar_url } : {}),
          verified: r.verified,
        }
      })

      return {
        jurisdictionName,
        entries,
        nextOffset: more === null ? null : offset + limit,
        participantCount,
        viewerRank,
        viewerHours,
      }
    },

    async listEntries(
      args: ListEntriesArgs,
    ): Promise<{ items: VolunteerHoursEntryView[]; nextCursor: string | null }> {
      const sources = args.sources ?? ITEMISED_SOURCES
      const keyset =
        args.cursor !== null
          ? sql`AND (vh.created_at, vh.id) < (${args.cursor.at}, ${args.cursor.id}::uuid)`
          : sql``
      const rows = await sql<LedgerRow[]>`
        SELECT
          vh.id,
          vh.source,
          vh.hours::float8 AS hours,
          vh.created_at,
          c.scheduled_at,
          vh.cleanup_id,
          c.title AS cleanup_title,
          c.reference_code,
          vh.report_id,
          vh.jurisdiction_geoid,
          j.name AS jurisdiction_name,
          lb.id AS creditor_id,
          lb.display_name AS creditor_name,
          lb.handle AS creditor_handle,
          EXISTS (
            SELECT 1 FROM user_verification uv
            WHERE uv.user_id = lb.id AND uv.status = 'verified'
          ) AS creditor_verified
        FROM volunteer_hours vh
        LEFT JOIN cleanups c      ON c.id = vh.cleanup_id
        LEFT JOIN jurisdictions j ON j.geoid = vh.jurisdiction_geoid
        LEFT JOIN users lb        ON lb.id = vh.logged_by_user_id
        WHERE vh.user_id = ${args.userId}
          AND vh.voided_at IS NULL
          AND vh.source = ANY(${sources as string[]}::text[])
          ${keyset}
        ORDER BY vh.created_at DESC, vh.id DESC
        LIMIT ${args.limit + 1}
      `
      const { items, nextCursor } = pageWith(rows, args.limit, (last) =>
        encodeTimeCursor({ at: last.created_at, id: last.id }),
      )
      return { items: items.map(toEntryView), nextCursor }
    },

    async listEventHours(cleanupId: string, viewerId: string | null): Promise<EventHoursLedger> {
      const mine = viewerId !== null ? sql`AND vh.user_id = ${viewerId}::uuid` : sql``
      const rows = await sql<{ user_id: string; hours: number; created_at: Date }[]>`
        SELECT vh.user_id, vh.hours::float8 AS hours, vh.created_at
        FROM volunteer_hours vh
        WHERE vh.cleanup_id = ${cleanupId}
          AND vh.source = 'event'
          AND vh.voided_at IS NULL
          ${mine}
        ORDER BY vh.created_at DESC, vh.id DESC
        LIMIT ${EVENT_HOURS_MEMBER_CAP}
      `
      const entries = rows.map((r) => ({
        userId: r.user_id,
        hours: r.hours,
        loggedAt: r.created_at,
      }))
      if (viewerId === null) return { entries, anyLogged: entries.length > 0 }
      const probe = await sql<{ any_logged: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM volunteer_hours
          WHERE cleanup_id = ${cleanupId} AND source = 'event' AND voided_at IS NULL
        ) AS any_logged
      `
      return { entries, anyLogged: probe[0]?.any_logged ?? false }
    },

    async hoursVisibilityFor(userId: string): Promise<HoursVisibility> {
      const rows = await sql<{ aggregate: boolean; items: boolean }[]>`
        SELECT
          (show_volunteer_hours IS NOT FALSE) AS aggregate,
          (show_volunteer_hours IS TRUE) AS items
        FROM users
        WHERE id = ${userId} AND deleted_at IS NULL
        LIMIT 1
      `
      const row = rows[0]
      if (row === undefined) return { aggregate: false, items: false }
      return { aggregate: row.aggregate, items: row.items }
    },

    async entriesForCertificate(args: EntriesForCertificateArgs): Promise<CertificateEntriesPage> {
      const geoidFilter =
        args.geoid !== null ? sql`AND vh.jurisdiction_geoid = ${args.geoid}` : sql``
      const fromFilter = args.from !== null ? sql`AND vh.created_at >= ${args.from}` : sql``
      const toFilter = args.to !== null ? sql`AND vh.created_at <= ${args.to}` : sql``
      const rows = await sql<LedgerRow[]>`
        SELECT
          vh.id,
          vh.source,
          vh.hours::float8 AS hours,
          vh.created_at,
          c.scheduled_at,
          vh.cleanup_id,
          c.title AS cleanup_title,
          c.reference_code,
          vh.report_id,
          vh.jurisdiction_geoid,
          j.name AS jurisdiction_name,
          lb.id AS creditor_id,
          lb.display_name AS creditor_name,
          lb.handle AS creditor_handle,
          EXISTS (
            SELECT 1 FROM user_verification uv
            WHERE uv.user_id = lb.id AND uv.status = 'verified'
          ) AS creditor_verified
        FROM volunteer_hours vh
        LEFT JOIN cleanups c      ON c.id = vh.cleanup_id
        LEFT JOIN jurisdictions j ON j.geoid = vh.jurisdiction_geoid
        LEFT JOIN users lb        ON lb.id = vh.logged_by_user_id
        WHERE vh.user_id = ${args.userId}
          AND vh.voided_at IS NULL
          AND vh.source <> 'report'
          ${geoidFilter}
          ${fromFilter}
          ${toFilter}
        ORDER BY vh.created_at DESC, vh.id DESC
        LIMIT ${args.limit}
      `
      const countRows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM volunteer_hours vh
        WHERE vh.user_id = ${args.userId}
          AND vh.voided_at IS NULL
          AND vh.source <> 'report'
          ${geoidFilter}
          ${fromFilter}
          ${toFilter}
      `
      const items = rows.reverse().map(toEntryView)
      return {
        items,
        totalHours: Math.round(items.reduce((sum, r) => sum + r.hours, 0) * 100) / 100,
        entryCount: countRows[0]?.count ?? items.length,
      }
    },
  }
}
