import { AppError, avatarGradient } from "@civfix/shared"
import type {
  LeaderboardEntryDTO,
  OrganizationRefDTO,
  OrgVerificationStatus,
  VolunteerHoursSource,
} from "@civfix/shared"
import { CIVFIX_OFFICIAL_USER_ID, isOfficialAccount } from "../auth/official-account.js"
import type { Queryable, Sql, TransactionSql } from "../db/client.js"
import { encodeTimeCursor, pageWith } from "../db/cursor-helpers.js"
import { writeAudit } from "./admin/audit.js"
import { blockedPairExpr, hiddenIdentity } from "./hidden-identity.js"
import { servedKeyExpr } from "./media-served-key.js"
import {
  hoursHeldOnServiceDate,
  lockEventCredits,
  lockUserCredits,
  sameDayEventHours,
  writeEventCredits,
} from "./volunteer-hours-credit.drizzle.js"
import { assertWithinDailyHoursCap } from "./volunteer-hours-rules.js"
import {
  DAILY_HOURS_CAP,
  EVENT_HOURS_MEMBER_CAP,
  ITEMISED_SOURCES,
  MANUAL_CREDIT_REPEAT_WINDOW_MS,
  MAX_ORG_CHIPS_FETCH,
  OPERATOR_LEDGER_MAX_LIMIT,
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
  OperatorCreditResult,
  OperatorEventCreditArgs,
  OperatorLedgerArgs,
  OperatorLedgerEntryView,
  OperatorLedgerTotals,
  OperatorManualCreditArgs,
  OperatorVoidArgs,
  OrgHoursView,
  VolunteerHoursAnomaly,
  VolunteerHoursEntryView,
  VolunteerHoursRepository,
  VoidedEntry,
} from "./volunteer-hours-service.js"

const MORE_PAGES = "more"

const RECIPROCAL_LOOKBACK_INTERVAL = `${RECIPROCAL_LOOKBACK_MS / 1000} seconds`
const WEEKLY_WINDOW_INTERVAL = "7 days"
const MANUAL_REPEAT_INTERVAL = `${MANUAL_CREDIT_REPEAT_WINDOW_MS / 1000} seconds`

// Transcripts and entry lists date a row by when the service happened: the event's start, a manual
// row's service day, and only failing both, when the row was written. A manual row has no
// jurisdiction and so no zone of its own; it is anchored at noon UTC on its date so that no reader
// within ±11 h of UTC sees it on a neighbouring day, whatever the session time zone.
function occurredAtExpr(sql: Queryable) {
  return sql`COALESCE(
    c.scheduled_at,
    make_timestamptz(
      extract(year FROM vh.service_date)::int,
      extract(month FROM vh.service_date)::int,
      extract(day FROM vh.service_date)::int,
      12, 0, 0, 'UTC'
    ),
    vh.created_at
  )`
}

interface LedgerRow {
  id: string
  source: VolunteerHoursSource
  hours: number
  created_at: Date
  occurred_at: Date
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
    occurredAt: r.occurred_at,
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

interface OperatorLedgerRow {
  id: string
  source: VolunteerHoursSource
  hours: number
  created_at: Date
  occurred_at: Date
  service_date: string | null
  cleanup_id: string | null
  cleanup_title: string | null
  reference_code: string | null
  jurisdiction_geoid: string | null
  jurisdiction_name: string | null
  creditor_id: string | null
  creditor_name: string | null
  creditor_handle: string | null
  operator_id: string | null
  operator_name: string | null
  note: string | null
  voided_at: Date | null
  voided_by_id: string | null
  voided_by_name: string | null
  void_reason: string | null
}

function toOperatorLedgerView(r: OperatorLedgerRow): OperatorLedgerEntryView {
  return {
    id: r.id,
    source: r.source,
    hours: r.hours,
    occurredAt: r.occurred_at,
    createdAt: r.created_at,
    serviceDate: r.service_date,
    event:
      r.cleanup_id !== null
        ? { id: r.cleanup_id, title: r.cleanup_title ?? "", referenceCode: r.reference_code }
        : null,
    jurisdiction:
      r.jurisdiction_geoid !== null
        ? { geoid: r.jurisdiction_geoid, name: r.jurisdiction_name }
        : null,
    creditedBy:
      r.creditor_id !== null
        ? {
            id: r.creditor_id,
            name: r.creditor_name ?? "",
            handle: r.creditor_handle ?? "",
            official: isOfficialAccount(r.creditor_id),
          }
        : null,
    operator: r.operator_id !== null ? { id: r.operator_id, name: r.operator_name ?? "" } : null,
    note: r.note,
    voidedAt: r.voided_at,
    voidedBy: r.voided_by_id !== null ? { id: r.voided_by_id, name: r.voided_by_name ?? "" } : null,
    voidReason: r.void_reason,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

async function eventEntryId(
  tx: TransactionSql,
  cleanupId: string,
  userId: string,
): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM volunteer_hours
    WHERE cleanup_id = ${cleanupId} AND user_id = ${userId} AND source = 'event'
    LIMIT 1
  `
  const id = rows[0]?.id
  if (id === undefined) throw new Error("creditEventAsOperator: the upserted event row is missing")
  return id
}

async function refuseUnvoidable(tx: TransactionSql, args: OperatorVoidArgs): Promise<never> {
  const rows = await tx<{ source: VolunteerHoursSource; voided: boolean }[]>`
    SELECT source, (voided_at IS NOT NULL) AS voided
    FROM volunteer_hours
    WHERE id = ${args.entryId} AND user_id = ${args.userId}
    LIMIT 1
  `
  const row = rows[0]
  if (row === undefined) throw AppError.notFound("Hours entry not found")
  if (row.voided) throw AppError.conflict("That hours entry is already void.")
  throw AppError.conflict("Report credits are retired and can't be voided.")
}

export function makeDrizzleVolunteerHoursRepository(sql: Sql): VolunteerHoursRepository {
  return {
    async logEventHours(args: LogEventHoursArgs): Promise<LogEventHoursResult> {
      if (args.entries.length === 0) return { credited: 0, changed: [], anomalies: [] }
      const userIds = args.entries.map((e) => e.userId)
      return sql.begin(async (tx) => {
        await lockEventCredits(tx, args.cleanupId, userIds)

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

        assertWithinDailyHoursCap(
          args.entries,
          await sameDayEventHours(tx, args.cleanupId, userIds),
          args.dailyCapHours ?? DAILY_HOURS_CAP,
        )

        const changed = await writeEventCredits(tx, {
          cleanupId: args.cleanupId,
          geoid: args.geoid,
          actorId: args.actorId,
          loggedByUserId: args.actorId,
          note: null,
          creditedByOperatorId: null,
          entries: args.entries,
        })
        const anomalies = await detectHoursAnomalies(tx, {
          actorId: args.actorId,
          cleanupId: args.cleanupId,
          userIds,
          weeklyFlagHours: args.weeklyFlagHours ?? WEEKLY_HOURS_FLAG_DEFAULT,
        })
        return { credited: args.entries.length, changed, anomalies }
      })
    },

    async totalsFor(userId: string): Promise<MyVolunteerHoursTotals> {
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
      const orgRows = await sql<OrgHoursRow[]>`
        SELECT
          o.id,
          o.slug,
          o.name,
          ${servedKeyExpr(sql, "am")} AS logo_key,
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
      `
      const totalHours = await computeTotalHours(sql, userId)
      return { totalHours, byJurisdiction, byOrganization: orgRows.map(toOrgHoursView) }
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
          ? sql`AND (vh.created_at, vh.id) < (${args.cursor.at}, ${args.cursor.id}::uuid)`
          : sql``
      const rows = await sql<LedgerRow[]>`
        SELECT
          vh.id,
          vh.source,
          vh.hours::float8 AS hours,
          vh.created_at,
          ${occurredAtExpr(sql)} AS occurred_at,
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
      const { items, nextCursor } = pageWith(rows, args.limit, (last) =>
        encodeTimeCursor({ at: last.created_at, id: last.id }),
      )
      return { items: items.map(toEntryView), nextCursor }
    },

    async listEventHours(cleanupId: string, viewerId: string | null): Promise<EventHoursLedger> {
      const mine = viewerId !== null ? sql`AND vh.user_id = ${viewerId}::uuid` : sql``
      const rows = await sql<
        { user_id: string; hours: number; created_at: Date; logged_by_user_id: string | null }[]
      >`
        SELECT vh.user_id, vh.hours::float8 AS hours, vh.created_at, vh.logged_by_user_id
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
        creditedByOfficial: isOfficialAccount(r.logged_by_user_id),
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
          ${occurredAtExpr(sql)} AS occurred_at,
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

    async creditEventAsOperator(args: OperatorEventCreditArgs): Promise<OperatorCreditResult> {
      return sql.begin(async (tx) => {
        await lockEventCredits(tx, args.cleanupId, [args.userId])

        const live = await tx<{ hours: number }[]>`
          SELECT hours::float8 AS hours
          FROM volunteer_hours
          WHERE cleanup_id = ${args.cleanupId}
            AND user_id = ${args.userId}
            AND source = 'event'
            AND voided_at IS NULL
          LIMIT 1
        `
        const held = live[0]
        if (held !== undefined) {
          throw AppError.conflict(
            `That volunteer already holds ${round2(held.hours)} h for this event; void that entry first.`,
          )
        }

        const entries = [{ userId: args.userId, hours: args.hours }]
        assertWithinDailyHoursCap(
          entries,
          await sameDayEventHours(tx, args.cleanupId, [args.userId]),
          args.dailyCapHours ?? DAILY_HOURS_CAP,
        )

        await writeEventCredits(tx, {
          cleanupId: args.cleanupId,
          geoid: args.geoid,
          actorId: args.operatorId,
          loggedByUserId: CIVFIX_OFFICIAL_USER_ID,
          note: args.reason,
          creditedByOperatorId: args.operatorId,
          entries,
        })
        const entryId = await eventEntryId(tx, args.cleanupId, args.userId)
        await writeAudit(tx, {
          actorId: args.operatorId,
          action: "user.hours_credited",
          target: `user:${args.userId}`,
          meta: {
            entryId,
            source: "event",
            cleanupId: args.cleanupId,
            hours: args.hours,
            reason: args.reason,
          },
        })
        return { entryId }
      })
    },

    async creditManual(args: OperatorManualCreditArgs): Promise<OperatorCreditResult> {
      return sql.begin(async (tx) => {
        await lockUserCredits(tx, [args.userId])

        const repeat = await tx<{ id: string }[]>`
          SELECT id
          FROM volunteer_hours
          WHERE user_id = ${args.userId}
            AND source = 'manual'
            AND voided_at IS NULL
            AND hours = ${args.hours}::numeric(6, 2)
            AND service_date = ${args.serviceDate}::date
            AND credited_by_operator_id = ${args.operatorId}
            AND created_at > now() - ${MANUAL_REPEAT_INTERVAL}::interval
          LIMIT 1
        `
        if (repeat.length > 0) {
          throw AppError.conflict(
            "That adjustment was recorded moments ago; check the ledger before adding it again.",
          )
        }

        assertWithinDailyHoursCap(
          [{ userId: args.userId, hours: args.hours }],
          await hoursHeldOnServiceDate(tx, args.userId, args.serviceDate),
          args.dailyCapHours ?? DAILY_HOURS_CAP,
        )

        const inserted = await tx<{ id: string }[]>`
          INSERT INTO volunteer_hours (
            user_id, hours, source, logged_by_user_id, note, service_date, credited_by_operator_id
          )
          VALUES (
            ${args.userId}, ${args.hours}, 'manual', ${CIVFIX_OFFICIAL_USER_ID}, ${args.reason},
            ${args.serviceDate}::date, ${args.operatorId}
          )
          RETURNING id
        `
        const entryId = inserted[0]?.id
        if (entryId === undefined) throw new Error("creditManual: insert returned no row")
        await writeAudit(tx, {
          actorId: args.operatorId,
          action: "user.hours_credited",
          target: `user:${args.userId}`,
          meta: {
            entryId,
            source: "manual",
            hours: args.hours,
            serviceDate: args.serviceDate,
            reason: args.reason,
          },
        })
        return { entryId }
      })
    },

    async voidEntry(args: OperatorVoidArgs): Promise<VoidedEntry> {
      return sql.begin(async (tx) => {
        // user_id and cleanup_id never change on a row, so reading them before the locks is safe;
        // the event lock has to be known up front because it must be taken before the user lock.
        const owner = await tx<{ cleanup_id: string | null }[]>`
          SELECT cleanup_id FROM volunteer_hours
          WHERE id = ${args.entryId} AND user_id = ${args.userId}
          LIMIT 1
        `
        const found = owner[0]
        if (found === undefined) throw AppError.notFound("Hours entry not found")
        if (found.cleanup_id !== null) {
          await lockEventCredits(tx, found.cleanup_id, [args.userId])
        } else {
          await lockUserCredits(tx, [args.userId])
        }

        const voided = await tx<
          {
            source: VolunteerHoursSource
            cleanup_id: string | null
            jurisdiction_geoid: string | null
            hours: number
          }[]
        >`
          UPDATE volunteer_hours
          SET voided_at = now(),
              voided_by_operator_id = ${args.operatorId},
              void_reason = ${args.reason}
          WHERE id = ${args.entryId}
            AND user_id = ${args.userId}
            AND voided_at IS NULL
            AND source <> 'report'
          RETURNING source, cleanup_id, jurisdiction_geoid, hours::float8 AS hours
        `
        const row = voided[0]
        if (row === undefined) return refuseUnvoidable(tx, args)

        if (row.source === "event" && row.cleanup_id !== null) {
          await tx`
            INSERT INTO volunteer_hours_audit
              (cleanup_id, user_id, actor_user_id, previous_hours, new_hours)
            SELECT cleanup_id, user_id, ${args.operatorId}, hours, 0
            FROM volunteer_hours WHERE id = ${args.entryId}
          `
        }
        if (row.jurisdiction_geoid !== null) {
          await tx`
            UPDATE user_jurisdiction_hours ujh
            SET total_hours = ujh.total_hours - vh.hours
            FROM volunteer_hours vh
            WHERE vh.id = ${args.entryId}
              AND ujh.user_id = vh.user_id
              AND ujh.jurisdiction_geoid = vh.jurisdiction_geoid
          `
        }
        await writeAudit(tx, {
          actorId: args.operatorId,
          action: "user.hours_voided",
          target: `user:${args.userId}`,
          meta: {
            entryId: args.entryId,
            source: row.source,
            ...(row.cleanup_id !== null ? { cleanupId: row.cleanup_id } : {}),
            hours: row.hours,
            reason: args.reason,
          },
        })
        return { id: args.entryId, source: row.source, cleanupId: row.cleanup_id, hours: row.hours }
      })
    },

    async listOperatorLedger(
      args: OperatorLedgerArgs,
    ): Promise<{ items: OperatorLedgerEntryView[]; nextCursor: string | null }> {
      const limit = Math.min(Math.max(1, Math.floor(args.limit)), OPERATOR_LEDGER_MAX_LIMIT)
      const keyset =
        args.cursor !== null
          ? sql`AND (vh.created_at, vh.id) < (${args.cursor.at}, ${args.cursor.id}::uuid)`
          : sql``
      const rows = await sql<OperatorLedgerRow[]>`
        SELECT
          vh.id,
          vh.source,
          vh.hours::float8 AS hours,
          vh.created_at,
          ${occurredAtExpr(sql)} AS occurred_at,
          vh.service_date::text AS service_date,
          vh.cleanup_id,
          c.title AS cleanup_title,
          c.reference_code,
          vh.jurisdiction_geoid,
          j.name AS jurisdiction_name,
          lb.id AS creditor_id,
          lb.display_name AS creditor_name,
          lb.handle AS creditor_handle,
          op.id AS operator_id,
          op.display_name AS operator_name,
          vh.note,
          vh.voided_at,
          vb.id AS voided_by_id,
          vb.display_name AS voided_by_name,
          vh.void_reason
        FROM volunteer_hours vh
        LEFT JOIN cleanups c      ON c.id = vh.cleanup_id
        LEFT JOIN jurisdictions j ON j.geoid = vh.jurisdiction_geoid
        LEFT JOIN users lb        ON lb.id = vh.logged_by_user_id
        LEFT JOIN users op        ON op.id = vh.credited_by_operator_id
        LEFT JOIN users vb        ON vb.id = vh.voided_by_operator_id
        WHERE vh.user_id = ${args.userId}
          ${keyset}
        ORDER BY vh.created_at DESC, vh.id DESC
        LIMIT ${limit + 1}
      `
      const { items, nextCursor } = pageWith(rows, limit, (last) =>
        encodeTimeCursor({ at: last.created_at, id: last.id }),
      )
      return { items: items.map(toOperatorLedgerView), nextCursor }
    },

    async operatorLedgerTotals(userId: string): Promise<OperatorLedgerTotals> {
      const rows = await sql<{ live: number; voided: number }[]>`
        SELECT
          count(*) FILTER (WHERE voided_at IS NULL)::int AS live,
          count(*) FILTER (WHERE voided_at IS NOT NULL)::int AS voided
        FROM volunteer_hours
        WHERE user_id = ${userId}
      `
      return {
        totalHours: await computeTotalHours(sql, userId),
        liveEntries: rows[0]?.live ?? 0,
        voidedEntries: rows[0]?.voided ?? 0,
      }
    },
  }
}
