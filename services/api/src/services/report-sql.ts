import type { Queryable, SqlFragment } from "../db/client.js"
import { keysetInstant } from "../db/cursor-helpers.js"
import type {
  AddressPrecision,
  ReportAddressSource,
  ReportCategory,
  ReportStatus,
  ReportType,
} from "@civfix/shared"
import { PUBLIC_REPORT_STATUSES } from "./report-visibility.js"
import type {
  ReportMapPoint,
  ReportMediaView,
  ReportRecord,
  ReportTimelineView,
} from "./report-types.js"

export interface ReportRowSelect {
  id: string
  reporter_user_id: string | null
  anon_session_id: string | null
  category: ReportCategory
  type: ReportType
  title: string | null
  description: string | null
  addr: string | null
  addr_source: ReportAddressSource | null
  addr_precision: AddressPrecision | null
  status: ReportStatus
  visibility: "public" | "hidden"
  lng: number
  lat: number
  geom_source: "device" | "exif" | "manual"
  jurisdiction_geoid: string | null
  reference_code: string | null
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
    addrSource: r.addr_source,
    addrPrecision: r.addr_precision,
    status: r.status,
    visibility: r.visibility,
    lat: r.lat,
    lng: r.lng,
    geomSource: r.geom_source,
    jurisdictionGeoid: r.jurisdiction_geoid,
    referenceCode: r.reference_code,
    createdAt: r.created_at,
    publishedAt: r.published_at,
    deletedAt: r.deleted_at,
  }
}

export function reportColumns(sql: Queryable) {
  return sql`
    id, reporter_user_id, anon_session_id, category, type, title, description, addr, addr_source,
    addr_precision, status, visibility,
    ST_X(geom) AS lng, ST_Y(geom) AS lat, geom_source, jurisdiction_geoid, reference_code,
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
  kind: string | null
  body: string | null
  created_at: Date
}

export function toTimelineView(t: TimelineRowSelect): ReportTimelineView {
  return { status: t.status, note: t.note, kind: t.kind, body: t.body, createdAt: t.created_at }
}

export function publicReportFilter(sql: Queryable): SqlFragment {
  return sql`
    r.status = ANY(${[...PUBLIC_REPORT_STATUSES]}::text[])
    AND r.visibility = 'public'
    AND r.deleted_at IS NULL
  `
}

export function firstReadyStillLateral(sql: Queryable): SqlFragment {
  return sql`
    LEFT JOIN LATERAL (
      SELECT thumb_key, served_key AS r2_key
      FROM media_assets
      WHERE report_id = r.id
        AND status = 'ready'
        AND served_key IS NOT NULL
        AND (kind = 'image' OR thumb_key IS NOT NULL)
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    ) m ON true
  `
}

export interface PublicPinRow {
  id: string
  lng: number
  lat: number
  category: ReportCategory
  type: ReportType
  status: ReportStatus
  title: string | null
  description: string | null
  addr: string | null
  reference_code: string | null
  thumb_key: string | null
  r2_key: string | null
  created_at: Date
  cursor_at: string | null
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
    addr: r.addr,
    referenceCode: r.reference_code,
    thumbKey: r.thumb_key,
    r2Key: r.r2_key,
  }
}

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
      r.addr,
      r.reference_code,
      m.thumb_key,
      m.r2_key,
      r.created_at,
      ${keysetInstant(sql, sql`r.created_at`)} AS cursor_at
    FROM reports r
    ${firstReadyStillLateral(sql)}
    WHERE ${publicReportFilter(sql)}
      ${extraFilters}
    ${order}
    LIMIT ${limit}
  `
  return rows
}
