import type {
  CleanupMemberRole,
  CleanupStatus,
  EventPageStatus,
  EventVisibility,
  OrganizationMemberRole,
} from "@civfix/shared"
import type { Queryable, Sql } from "../../db/client.js"
import { encodeTimeCursor, pageWith, parseTimeCursor } from "../../db/cursor-helpers.js"
import { publicServedKeyExpr } from "../media-served-key.js"
import { cleanupStatusExpr } from "../cleanup-sql.js"
import type {
  HostPortfolioKpiRecord,
  HostPortfolioKpisArgs,
  HostPortfolioRepository,
  HostedEventRecord,
  ListHostedEventsArgs,
} from "./host-portfolio-repository.js"

export interface HostPortfolioTotals {
  totalRegistrations: number
  totalCheckedIn: number
}

export interface HostPortfolioTotalsArgs {
  userId: string
  organizationId: string | null
}

interface HostedEventRowSelect {
  id: string
  reference_code: string | null
  title: string
  scheduled_at: Date
  ends_at: Date | null
  timezone: string | null
  status: CleanupStatus
  visibility: EventVisibility
  cover_key: string | null
  capacity: number | null
  event_role: CleanupMemberRole | null
  org_role: OrganizationMemberRole | null
  org_id: string | null
  org_name: string | null
  page_slug: string | null
  page_status: EventPageStatus | null
}

function toRecord(row: HostedEventRowSelect): HostedEventRecord {
  return {
    id: row.id,
    referenceCode: row.reference_code,
    title: row.title,
    startsAt: row.scheduled_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    status: row.status,
    visibility: row.visibility,
    coverKey: row.cover_key,
    capacity: row.capacity,
    eventRole: row.event_role,
    orgRole: row.org_role,
    orgId: row.org_id,
    orgName: row.org_name,
    pageSlug: row.page_slug,
    pageStatus: row.page_status,
  }
}

function hostedIds(sql: Queryable, userId: string) {
  return sql`(
    SELECT m.cleanup_id AS id
    FROM cleanup_members m
    WHERE m.user_id = ${userId} AND m.role <> 'member'
    UNION
    SELECT oc.id
    FROM organization_members om
    JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL
    JOIN cleanups oc ON oc.organization_id = om.organization_id
    WHERE om.user_id = ${userId} AND om.role <> 'member'
  )`
}

function orgFilter(sql: Queryable, organizationId: string | null) {
  return organizationId !== null ? sql`AND c.organization_id = ${organizationId}` : sql``
}

/**
 * Portfolio-wide like eventsHosted (no `when` tab, no page bound), with the same registered and
 * checked-in definitions hostedEventCounts uses per row.
 */
export async function hostedRegistrationTotals(
  sql: Queryable,
  args: HostPortfolioTotalsArgs,
): Promise<HostPortfolioTotals> {
  const rows = await sql<{ total_registrations: number; total_checked_in: number }[]>`
    WITH hosted AS ${hostedIds(sql, args.userId)},
    scoped AS (
      SELECT c.id FROM hosted h JOIN cleanups c ON c.id = h.id
      WHERE TRUE ${orgFilter(sql, args.organizationId)}
    )
    SELECT
      COALESCE((
        SELECT sum(r.party_size)::int FROM cleanup_registrations r
        WHERE r.cleanup_id IN (SELECT id FROM scoped) AND r.status = 'registered'
      ), 0) AS total_registrations,
      COALESCE((
        SELECT count(*)::int FROM cleanup_registration_seats s
        WHERE s.cleanup_id IN (SELECT id FROM scoped)
          AND s.status = 'active' AND s.checked_in_at IS NOT NULL
      ), 0) AS total_checked_in
  `
  const row = rows[0]
  return {
    totalRegistrations: row?.total_registrations ?? 0,
    totalCheckedIn: row?.total_checked_in ?? 0,
  }
}

export async function eventHoursByCleanup(
  sql: Queryable,
  cleanupIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (cleanupIds.length === 0) return out
  const rows = await sql<{ cleanup_id: string; hours: number }[]>`
    SELECT vh.cleanup_id, COALESCE(sum(vh.hours), 0)::float8 AS hours
      FROM volunteer_hours vh
     WHERE vh.cleanup_id = ANY(${[...cleanupIds]}::uuid[])
       AND vh.source = 'event'
       AND vh.voided_at IS NULL
     GROUP BY vh.cleanup_id`
  for (const row of rows) out.set(row.cleanup_id, Number(row.hours))
  return out
}

export function makeDrizzleHostPortfolioRepository(sql: Sql): HostPortfolioRepository {
  return {
    async listHostedEvents(
      args: ListHostedEventsArgs,
    ): Promise<{ items: HostedEventRecord[]; nextCursor: string | null }> {
      const past = args.when === "past"
      const cursor = parseTimeCursor(args.cursor)
      const cursorFilter =
        cursor !== null
          ? past
            ? sql`AND (c.scheduled_at, c.id) < (${cursor.at}, ${cursor.id}::uuid)`
            : sql`AND (c.scheduled_at, c.id) > (${cursor.at}, ${cursor.id}::uuid)`
          : sql``
      const whenFilter =
        args.when === "upcoming"
          ? sql`AND c.status <> 'cancelled' AND c.ends_at > now()`
          : past
            ? sql`AND (c.ends_at <= now() OR c.status = 'cancelled')`
            : sql``
      const order = past
        ? sql`ORDER BY c.scheduled_at DESC, c.id DESC`
        : sql`ORDER BY c.scheduled_at ASC, c.id ASC`
      const rows = await sql<HostedEventRowSelect[]>`
        WITH hosted AS ${hostedIds(sql, args.userId)}
        SELECT
          c.id,
          c.reference_code,
          c.title,
          c.scheduled_at,
          c.ends_at,
          c.timezone,
          ${cleanupStatusExpr(sql)} AS status,
          c.visibility,
          ${publicServedKeyExpr(sql, "ma")} AS cover_key,
          c.capacity,
          c.page_slug,
          p.status AS page_status,
          (
            SELECT m.role FROM cleanup_members m
            WHERE m.cleanup_id = c.id AND m.user_id = ${args.userId}
            LIMIT 1
          ) AS event_role,
          (
            SELECT om.role FROM organization_members om
            JOIN organizations oo ON oo.id = om.organization_id AND oo.deleted_at IS NULL
            WHERE om.organization_id = c.organization_id AND om.user_id = ${args.userId}
            LIMIT 1
          ) AS org_role,
          o.id AS org_id,
          o.name AS org_name
        FROM hosted h
        JOIN cleanups c ON c.id = h.id
        LEFT JOIN media_assets ma ON ma.id = c.cover_media_id
        LEFT JOIN cleanup_pages p ON p.cleanup_id = c.id
        LEFT JOIN organizations o ON o.id = c.organization_id AND o.deleted_at IS NULL
        WHERE TRUE
          ${whenFilter}
          ${orgFilter(sql, args.organizationId)}
          ${cursorFilter}
        ${order}
        LIMIT ${args.limit + 1}
      `
      return pageWith(rows.map(toRecord), args.limit, (last) =>
        encodeTimeCursor({ at: last.startsAt, id: last.id }),
      )
    },

    async kpisFor(args: HostPortfolioKpisArgs): Promise<HostPortfolioKpiRecord> {
      const rows = await sql<{ events_hosted: number; upcoming_events: number }[]>`
        WITH hosted AS ${hostedIds(sql, args.userId)}
        SELECT
          count(*)::int AS events_hosted,
          count(*) FILTER (
            WHERE c.status <> 'cancelled' AND c.ends_at > ${args.now}
          )::int AS upcoming_events
        FROM hosted h
        JOIN cleanups c ON c.id = h.id
        WHERE TRUE
          ${orgFilter(sql, args.organizationId)}
      `
      const row = rows[0]
      return {
        eventsHosted: row?.events_hosted ?? 0,
        upcomingEvents: row?.upcoming_events ?? 0,
      }
    },
  }
}
