import type postgres from "postgres"
import type { Queryable } from "../db/client.js"
import type { ReportCategory, ReportStatus, ReportType } from "@civfix/shared"
import type {
  ReportMapPoint,
  ReportMediaView,
  ReportRecord,
  ReportTimelineView,
} from "./report-service.types.js"

type SqlFragment = postgres.Fragment

// Whether `reportId` is a (non-deleted) report whose reporter is `userId`. Lives in the persistence layer
// so callers (e.g. the content-report route's owner-takedown detection) don't issue raw SQL themselves.
export async function reportOwnedBy(
  sql: Queryable,
  reportId: string,
  userId: string,
): Promise<boolean> {
  const rows = await sql<{ reporter_user_id: string | null }[]>`
    SELECT reporter_user_id FROM reports
    WHERE id = ${reportId} AND deleted_at IS NULL
    LIMIT 1
  `
  return rows[0]?.reporter_user_id === userId
}

// Shape of a report row as selected back (geom decoded to lng/lat via ST_X/ST_Y).
export interface ReportRowSelect {
  id: string
  reporter_user_id: string | null
  anon_session_id: string | null
  category: ReportCategory
  type: ReportType
  title: string | null
  description: string | null
  addr: string | null
  status: ReportStatus
  visibility: "public" | "hidden"
  lng: number
  lat: number
  geom_source: "device" | "exif" | "manual"
  jurisdiction_geoid: string | null
  created_at: Date
  published_at: Date | null
  deleted_at: Date | null
}

export function toRecord(r: ReportRowSelect): ReportRecord {
  return {
    id: r.id,
    reporterUserId: r.reporter_user_id,
    anonSessionId: r.anon_session_id,
    category: r.category,
    type: r.type,
    title: r.title,
    description: r.description,
    addr: r.addr,
    status: r.status,
    visibility: r.visibility,
    lat: r.lat,
    lng: r.lng,
    geomSource: r.geom_source,
    jurisdictionGeoid: r.jurisdiction_geoid,
    createdAt: r.created_at,
    publishedAt: r.published_at,
    deletedAt: r.deleted_at,
  }
}

// The SELECT list (geom decoded) shared by every report read.
export function reportColumns(sql: Queryable) {
  return sql`
    id, reporter_user_id, anon_session_id, category, type, title, description, addr, status, visibility,
    ST_X(geom) AS lng, ST_Y(geom) AS lat, geom_source, jurisdiction_geoid,
    created_at, published_at, deleted_at
  `
}

export interface MediaRowSelect {
  id: string
  kind: "image" | "video"
  codec: string | null
  r2_key: string
  thumb_key: string | null
  status: "validating" | "ready" | "rejected" | "held"
  width: number | null
  height: number | null
}

export function toMediaView(m: MediaRowSelect): ReportMediaView {
  return {
    id: m.id,
    kind: m.kind,
    codec: m.codec,
    r2Key: m.r2_key,
    thumbKey: m.thumb_key,
    status: m.status,
    width: m.width,
    height: m.height,
  }
}

export interface TimelineRowSelect {
  status: ReportStatus
  note: string | null
  created_at: Date
}

export function toTimelineView(t: TimelineRowSelect): ReportTimelineView {
  return { status: t.status, note: t.note, createdAt: t.created_at }
}

// A public map/search pin row before projection. created_at backs the search keyset cursor; the map path
// ignores it.
export interface PublicPinRow {
  id: string
  lng: number
  lat: number
  category: ReportCategory
  type: ReportType
  status: ReportStatus
  title: string | null
  description: string | null
  thumb_key: string | null
  r2_key: string | null
  created_at: Date
}

export function toMapPoint(r: PublicPinRow): ReportMapPoint {
  return {
    id: r.id,
    lat: r.lat,
    lng: r.lng,
    category: r.category,
    type: r.type,
    status: r.status,
    title: r.title,
    description: r.description,
    thumbKey: r.thumb_key,
    r2Key: r.r2_key,
  }
}

// findMapCandidates + searchReports are ~85% identical: same status/visibility gate, same first-visible-
// photo LATERAL preview, same projection. Only the extra WHERE fragments, ORDER BY, and LIMIT differ, so
// they thread in here. The LATERAL picks the report's earliest VISIBLE (`ready`) image — the same status
// visibility the public detail read uses — and a LEFT JOIN so a report with no visible media still returns
// a row with null keys (no pin is dropped). The service presigns thumb_key/r2_key (the repo never signs).
export async function selectPublicPins(
  sql: Queryable,
  extraFilters: SqlFragment,
  order: SqlFragment,
  limit: number,
): Promise<PublicPinRow[]> {
  const rows = await sql<PublicPinRow[]>`
    SELECT
      r.id,
      ST_X(r.geom) AS lng,
      ST_Y(r.geom) AS lat,
      r.category,
      r.type,
      r.status,
      r.title,
      r.description,
      m.thumb_key,
      m.r2_key,
      r.created_at
    FROM reports r
    LEFT JOIN LATERAL (
      SELECT thumb_key, r2_key
      FROM media_assets
      WHERE report_id = r.id
        AND kind = 'image'
        AND status = 'ready'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    ) m ON true
    WHERE r.status = 'published'
      AND r.visibility = 'public'
      AND r.deleted_at IS NULL
      ${extraFilters}
    ${order}
    LIMIT ${limit}
  `
  return rows
}
