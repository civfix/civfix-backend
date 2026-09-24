import { AppError, avatarGradient } from "@civfix/shared"
import type {
  LeaderboardEntryDTO,
  OrganizationRefDTO,
  OrgVerificationStatus,
  VolunteerHoursSource,
} from "@civfix/shared"
import type { Queryable, Sql } from "../db/client.js"
import { keysetInstant, keysetPredicate, pageWith, paginateKeyset } from "../db/cursor-helpers.js"
import { hiddenIdentity } from "./hidden-identity.js"
import { blockedPairExpr } from "./blocks-sql.js"
import { publicServedKeyExpr } from "./media-served-key.js"
import { DEFAULT_EVENT_TIME_ZONE } from "./host/event-fields.js"
import {
  DAILY_HOURS_CAP,
  EVENT_HOURS_MEMBER_CAP,
  ITEMISED_SOURCES,
  MAX_ORG_CHIPS_FETCH,
  RECIPROCAL_LOOKBACK_MS,
  WEEKLY_HOURS_FLAG_DEFAULT,
} from "./volunteer-hours-service.js"
import type {
  CertificateEntriesPage,
  EntriesForCertificateArgs,
  EventHoursLedger,
  HoursVisibility,
  LeaderboardPage,
  ListEntriesArgs,
  LogEventHoursArgs,
  LogEventHoursResult,
  MyVolunteerHoursTotals,
  OrgHoursView,
  VolunteerHoursAnomaly,
  VolunteerHoursEntryView,
  VolunteerHoursRepository,
} from "./volunteer-hours-repository.js"
import { MS_PER_SECOND } from "../lib/time.js"

const MORE_PAGES = "more"

const HOURS_ROUNDING_FACTOR = 100

const RECIPROCAL_LOOKBACK_INTERVAL = `${RECIPROCAL_LOOKBACK_MS / MS_PER_SECOND} seconds`
const WEEKLY_WINDOW_INTERVAL = "7 days"

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
}

interface OrgHoursRow {
  id: string
  slug: string
  name: string
  logo_key: string | null
  verified_status: OrgVerificationStatus
  verified_kind: OrganizationRefDTO["verifiedKind"]
  hours: number
}

function round2(n: number): number {
  return Math.round(n * HOURS_ROUNDING_FACTOR) / HOURS_ROUNDING_FACTOR
}

function toOrgHoursView(r: OrgHoursRow): OrgHoursView {
  return {
    organizationId: r.id,
    slug: r.slug,
    name: r.name,
    logoKey: r.logo_key,
    verified: r.verified_status === "verified",
    verifiedKind: r.verified_kind,
    hours: r.hours,
  }
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
            organization: null,
          }
        : null,
  }
}

function totalHoursQuery(sql: Sql, userId: string) {
  return sql<{ total: number }[]>`
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
}

function totalHoursFrom(rows: readonly { total: number }[]): number {
  return round2(rows[0]?.total ?? 0)
}

async function detectHoursAnomalies(
  tx: Queryable,
  args: { actorId: string; cleanupId: string; userIds: string[]; weeklyFlagHours: number },
): Promise<VolunteerHoursAnomaly[]> {
  const anomalies: VolunteerHoursAnomaly[] = []

  const weekly = await tx<{ user_id: string; hours: number }[]>`
    SELECT user_id, COALESCE(SUM(hours), 0)::float8 AS hours
    FROM volunteer_hours
    WHERE user_id = ANY(${args.userIds}::uuid[])
      AND source <> 'report'
      AND voided_at IS NULL
      AND created_at >= now() - ${WEEKLY_WINDOW_INTERVAL}::interval
    GROUP BY user_id
    HAVING COALESCE(SUM(hours), 0) > ${args.weeklyFlagHours}
  `
  for (const row of weekly) {
    anomalies.push({
      kind: "weekly_hours",
      userId: row.user_id,
      counterpartUserId: null,
      hours: row.hours,
    })
  }

  const swaps = await tx<{ logged_by_user_id: string }[]>`
    SELECT DISTINCT logged_by_user_id
    FROM volunteer_hours
    WHERE user_id = ${args.actorId}
      AND source = 'event'
      AND voided_at IS NULL
      AND cleanup_id <> ${args.cleanupId}
      AND created_at >= now() - ${RECIPROCAL_LOOKBACK_INTERVAL}::interval
      AND logged_by_user_id = ANY(${args.userIds}::uuid[])
  `
  for (const row of swaps) {
    anomalies.push({
      kind: "reciprocal_credit",
      userId: row.logged_by_user_id,
      counterpartUserId: args.actorId,
      hours: null,
    })
  }

  return anomalies
}

interface EventHoursWrite {
  args: LogEventHoursArgs
  userIds: string[]
  hoursByRow: number[]
}

async function lockEventAndUsers(tx: Queryable, { args, userIds }: EventHoursWrite): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('volunteer_event:' || ${args.cleanupId}))`
  const lockIds = [...new Set(userIds)].sort()
  if (lockIds.length > 0) {
    await tx`
            SELECT pg_advisory_xact_lock(hashtext('volunteer_user:' || u))
            FROM unnest(${lockIds}::uuid[]) AS t(u)
            ORDER BY u
          `
  }
}

async function assertNoReciprocalCredit(
  tx: Queryable,
  { args, userIds }: EventHoursWrite,
): Promise<void> {
  const reciprocal = await tx<{ logged_by_user_id: string }[]>`
          SELECT DISTINCT logged_by_user_id
          FROM volunteer_hours
          WHERE cleanup_id = ${args.cleanupId}
            AND source = 'event'
            AND user_id = ${args.actorId}
            AND voided_at IS NULL
            AND logged_by_user_id <> ${args.actorId}
            AND logged_by_user_id = ANY(${userIds}::uuid[])
        `
  if (reciprocal.length > 0) {
    throw AppError.conflict(
      "You can't credit hours to someone who has already credited you for this event.",
    )
  }
}

async function assertWithinDailyCap(
  tx: Queryable,
  { args, userIds }: EventHoursWrite,
): Promise<void> {
  const sameDay = await tx<{ user_id: string; hours: number }[]>`
          SELECT vh.user_id, COALESCE(SUM(vh.hours), 0)::float8 AS hours
          FROM volunteer_hours vh
          JOIN cleanups c ON c.id = vh.cleanup_id
          WHERE vh.user_id = ANY(${userIds}::uuid[])
            AND vh.source = 'event'
            AND vh.voided_at IS NULL
            AND vh.cleanup_id <> ${args.cleanupId}
            AND (c.scheduled_at AT TIME ZONE COALESCE(c.timezone, ${DEFAULT_EVENT_TIME_ZONE}))::date = (
              SELECT (scheduled_at AT TIME ZONE COALESCE(timezone, ${DEFAULT_EVENT_TIME_ZONE}))::date
              FROM cleanups WHERE id = ${args.cleanupId}
            )
          GROUP BY vh.user_id
        `
  const dailyCapHours = args.dailyCapHours ?? DAILY_HOURS_CAP
  const heldByUser = new Map(sameDay.map((r) => [r.user_id, r.hours]))
  for (const entry of args.entries) {
    const held = heldByUser.get(entry.userId) ?? 0
    if (held + entry.hours > dailyCapHours) {
      throw AppError.conflict(
        `That attendee already holds ${round2(held)} h for events on this date; the daily limit is ${dailyCapHours} h.`,
      )
    }
  }
}

async function writeHoursAudit(
  tx: Queryable,
  { args, userIds, hoursByRow }: EventHoursWrite,
): Promise<LogEventHoursResult["changed"]> {
  const audit = await tx<{ user_id: string; previous_hours: number | null; new_hours: number }[]>`
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
  return audit.map((r) => ({
    userId: r.user_id,
    hours: r.new_hours,
    previousHours: r.previous_hours,
  }))
}

async function upsertEventHours(
  tx: Queryable,
  { args, userIds, hoursByRow }: EventHoursWrite,
): Promise<number> {
  if (args.geoid === null) {
    // With no jurisdiction there is no rollup to credit, so only a stale one from an earlier geoid is
    // reversed.
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
    return upserted.length
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
  return new Set(upserted.map((r) => r.user_id)).size
}

export function makeDrizzleVolunteerHoursRepository(sql: Sql): VolunteerHoursRepository {
  return {
    async logEventHours(args: LogEventHoursArgs): Promise<LogEventHoursResult> {
      if (args.entries.length === 0) return { credited: 0, changed: [], anomalies: [] }
      const write: EventHoursWrite = {
        args,
        userIds: args.entries.map((e) => e.userId),
        hoursByRow: args.entries.map((e) => e.hours),
      }
      return sql.begin(async (tx) => {
        await lockEventAndUsers(tx, write)
        await assertNoReciprocalCredit(tx, write)
        await assertWithinDailyCap(tx, write)
        const changed = await writeHoursAudit(tx, write)
        const credited = await upsertEventHours(tx, write)
        const anomalies = await detectHoursAnomalies(tx, {
          actorId: args.actorId,
          cleanupId: args.cleanupId,
          userIds: write.userIds,
          weeklyFlagHours: args.weeklyFlagHours ?? WEEKLY_HOURS_FLAG_DEFAULT,
        })
        return { credited, changed, anomalies }
      })
    },

    async totalsFor(userId: string): Promise<MyVolunteerHoursTotals> {
      const [rows, orgRows, totalRows] = await Promise.all([
        sql<{ geoid: string; name: string | null; hours: number }[]>`
          SELECT
            ujh.jurisdiction_geoid AS geoid,
            j.name AS name,
            ujh.total_hours::float8 AS hours
          FROM user_jurisdiction_hours ujh
          JOIN jurisdictions j ON j.geoid = ujh.jurisdiction_geoid
          WHERE ujh.user_id = ${userId} AND ujh.total_hours > 0
          ORDER BY ujh.total_hours DESC, ujh.jurisdiction_geoid
        `,
        sql<OrgHoursRow[]>`
          SELECT
            o.id,
            o.slug,
            o.name,
            ${publicServedKeyExpr(sql, "am")} AS logo_key,
            o.verified_status,
            o.verified_kind,
            sum(vh.hours)::float8 AS hours
          FROM volunteer_hours vh
          JOIN cleanups c ON c.id = vh.cleanup_id
          JOIN organizations o ON o.id = c.organization_id
          LEFT JOIN media_assets am ON am.id = o.logo_media_id
          WHERE vh.user_id = ${userId}
            AND vh.source = 'event'
            AND vh.voided_at IS NULL
            AND o.deleted_at IS NULL
            AND o.suspended_at IS NULL
          GROUP BY o.id, o.slug, o.name, am.id, o.verified_status, o.verified_kind
          ORDER BY sum(vh.hours) DESC, o.id
          LIMIT ${MAX_ORG_CHIPS_FETCH}
        `,
        totalHoursQuery(sql, userId),
      ])
      const byJurisdiction = rows.map((r) => ({ geoid: r.geoid, name: r.name, hours: r.hours }))
      return {
        totalHours: totalHoursFrom(totalRows),
        byJurisdiction,
        byOrganization: orgRows.map(toOrgHoursView),
      }
    },

    async totalHoursFor(userId: string): Promise<number> {
      return totalHoursFrom(await totalHoursQuery(sql, userId))
    },

    async leaderboard(
      geoid: string,
      limit: number,
      offset: number,
      viewerId: string | null,
      withExtras: boolean,
    ): Promise<LeaderboardPage> {
      const blockedPair = blockedPairExpr(sql, viewerId, sql`ujh.user_id`)

      const [jurRows, rows, meRows, countRows] = await Promise.all([
        sql<{ name: string }[]>`
          SELECT name FROM jurisdictions WHERE geoid = ${geoid} LIMIT 1
        `,
        sql<
          {
            user_id: string
            name: string
            handle: string | null
            avatar_url: string | null
            hours: number
            blocked_pair: boolean
          }[]
        >`
          SELECT
            ujh.user_id,
            u.display_name AS name,
            u.handle,
            u.avatar_url,
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
        `,
        withExtras && viewerId !== null
          ? sql<{ hours: number | null; rank: number | null }[]>`
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
          : null,
        withExtras && offset === 0
          ? sql<{ count: number }[]>`
              SELECT count(*)::int AS count
              FROM user_jurisdiction_hours ujh
              JOIN users u ON u.id = ujh.user_id
              WHERE ujh.jurisdiction_geoid = ${geoid}
                AND ujh.total_hours > 0
                AND u.deleted_at IS NULL
                AND u.show_volunteer_hours IS NOT FALSE
            `
          : null,
      ])
      const jurisdictionName = jurRows[0]?.name ?? null
      const viewerHours = meRows === null ? null : (meRows[0]?.hours ?? null)
      const viewerRank = meRows === null ? null : (meRows[0]?.rank ?? null)
      const participantCount = countRows === null ? null : (countRows[0]?.count ?? 0)

      const { items: page, nextCursor: more } = pageWith(rows, limit, () => MORE_PAGES)
      const entries: LeaderboardEntryDTO[] = page.map((r, i) => {
        const rankAndHours = { rank: offset + i + 1, userId: r.user_id, hours: r.hours }
        if (r.blocked_pair) {
          const hidden = hiddenIdentity(r.user_id)
          return { ...rankAndHours, name: hidden.name, avatar: hidden.avatar }
        }
        return {
          ...rankAndHours,
          name: r.name,
          ...(r.handle !== null ? { handle: r.handle } : {}),
          avatar: avatarGradient(r.user_id),
          ...(r.avatar_url !== null ? { avatarUrl: r.avatar_url } : {}),
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
          ? sql`AND ${keysetPredicate(sql, sql`vh.created_at`, sql`vh.id`, args.cursor)}`
          : sql``
      const rows = await sql<(LedgerRow & { cursor_at: string })[]>`
        SELECT
          vh.id,
          vh.source,
          vh.hours::float8 AS hours,
          vh.created_at,
          ${keysetInstant(sql, sql`vh.created_at`)} AS cursor_at,
          c.scheduled_at,
          vh.cleanup_id,
          c.title AS cleanup_title,
          c.reference_code,
          vh.report_id,
          vh.jurisdiction_geoid,
          j.name AS jurisdiction_name,
          lb.id AS creditor_id,
          lb.display_name AS creditor_name,
          lb.handle AS creditor_handle
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
      const { items, nextCursor } = paginateKeyset(rows, args.limit, (last) => ({
        atText: last.cursor_at,
        id: last.id,
      }))
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
      const [rows, countRows] = await Promise.all([
        sql<LedgerRow[]>`
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
            lb.handle AS creditor_handle
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
        `,
        sql<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM volunteer_hours vh
          WHERE vh.user_id = ${args.userId}
            AND vh.voided_at IS NULL
            AND vh.source <> 'report'
            ${geoidFilter}
            ${fromFilter}
            ${toFilter}
        `,
      ])
      const items = rows.reverse().map(toEntryView)
      return {
        items,
        totalHours: round2(items.reduce((sum, r) => sum + r.hours, 0)),
        entryCount: countRows[0]?.count ?? items.length,
      }
    },
  }
}
