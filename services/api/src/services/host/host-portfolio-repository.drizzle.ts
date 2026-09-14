import type {
  CleanupMemberRole,
  CleanupStatus,
  EventVisibility,
  OrganizationMemberRole,
} from "@civfix/shared"
import type { Sql } from "../../db/client.js"
import { encodeTimeCursor, pageWith, parseTimeCursor } from "../../db/cursor-helpers.js"
import { servedKeyExpr } from "../media-served-key.js"
import { cleanupStatusExpr } from "../cleanup-sql.js"

export interface HostedEventRecord {
  id: string
  referenceCode: string | null
  title: string
  startsAt: Date
  endsAt: Date | null
  timezone: string | null
  status: CleanupStatus
  visibility: EventVisibility
  coverKey: string | null
  capacity: number | null
  eventRole: CleanupMemberRole | null
  orgRole: OrganizationMemberRole | null
  orgId: string | null
  orgName: string | null
  pageSlug: string | null
}

export interface HostPortfolioKpiRecord {
  eventsHosted: number
  upcomingEvents: number
}

export interface ListHostedEventsArgs {
  userId: string
  when: "upcoming" | "past" | "all"
  organizationId: string | null
  cursor: string | null
  limit: number
}

export interface HostPortfolioKpisArgs {
  userId: string
  organizationId: string | null
  now: Date
}

export interface HostPortfolioRepository {
  listHostedEvents(
    args: ListHostedEventsArgs,
  ): Promise<{ items: HostedEventRecord[]; nextCursor: string | null }>
  kpisFor(args: HostPortfolioKpisArgs): Promise<HostPortfolioKpiRecord>
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
  }
}

export function makeDrizzleHostPortfolioRepository(sql: Sql): HostPortfolioRepository {
  const hostedIds = (userId: string) => sql`(
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

  const orgFilter = (organizationId: string | null) =>
    organizationId !== null ? sql`AND c.organization_id = ${organizationId}` : sql``

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
        WITH hosted AS ${hostedIds(args.userId)}
        SELECT
          c.id,
          c.reference_code,
          c.title,
          c.scheduled_at,
          c.ends_at,
          c.timezone,
          ${cleanupStatusExpr(sql)} AS status,
          c.visibility,
          ${servedKeyExpr(sql, "ma")} AS cover_key,
          c.capacity,
          c.page_slug,
          (
            SELECT m.role FROM cleanup_members m
            WHERE m.cleanup_id = c.id AND m.user_id = ${args.userId}
            LIMIT 1
          ) AS event_role,
          (
            SELECT om.role FROM organization_members om
            WHERE om.organization_id = c.organization_id AND om.user_id = ${args.userId}
            LIMIT 1
          ) AS org_role,
          o.id AS org_id,
          o.name AS org_name
        FROM hosted h
        JOIN cleanups c ON c.id = h.id
        LEFT JOIN media_assets ma ON ma.id = c.cover_media_id
        LEFT JOIN organizations o ON o.id = c.organization_id AND o.deleted_at IS NULL
        WHERE TRUE
          ${whenFilter}
          ${orgFilter(args.organizationId)}
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
        WITH hosted AS ${hostedIds(args.userId)}
        SELECT
          count(*)::int AS events_hosted,
          count(*) FILTER (
            WHERE c.status <> 'cancelled' AND c.ends_at > ${args.now}
          )::int AS upcoming_events
        FROM hosted h
        JOIN cleanups c ON c.id = h.id
        WHERE TRUE
          ${orgFilter(args.organizationId)}
      `
      const row = rows[0]
      return {
        eventsHosted: row?.events_hosted ?? 0,
        upcomingEvents: row?.upcoming_events ?? 0,
      }
    },
  }
}
