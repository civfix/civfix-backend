import type postgres from "postgres"
import type { Queryable } from "../db/client.js"
import type { ReportCategory, ReportStatus, ReportType } from "@civfix/shared"
import { PUBLIC_REPORT_STATUSES } from "./report-visibility.js"
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

// The SELECT list (geom decoded) shared by every report read.
export function reportColumns(sql: Queryable) {
  return sql`
    id, reporter_user_id, anon_session_id, category, type, title, description, addr, status, visibility,
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
  // D13: `kind` tags the entry (e.g. 'reply') and `body` carries the full untruncated text (an inbound
  // city reply); both NULLABLE (legacy rows have neither).
  kind: string | null
  body: string | null
  created_at: Date
}

export function toTimelineView(t: TimelineRowSelect): ReportTimelineView {
  return { status: t.status, note: t.note, kind: t.kind, body: t.body, createdAt: t.created_at }
}

/**
 * THE canonical "this report is publicly readable" SQL predicate (H8).
 *
 * This is the SQL half of the decision `report-visibility.ts:isReportVisibleTo` makes in TypeScript —
 * the two MUST agree, minus the owner carve-out (`mine`), which no anonymous/public read path has.
 * It existed only inlined inside `selectPublicPins`, so `post-repository.drizzle.ts` drifted twice:
 * `isReportAttachable` checked `visibility` but not `status` (a HELD, pre-moderation anon report could
 * be attached to a public post), and `loadReports` re-read the row on every render checking NEITHER (so
 * an owner's later `unlist` was silently ineffective for the life of the post). Every new call site
 * MUST use this fragment rather than re-typing the three conditions.
 *
 * The status SET comes from report-visibility.ts:PUBLIC_REPORT_STATUSES — a report stays public while
 * the city works it (acknowledged / in_progress / resolved); read that constant's doc before narrowing
 * this again.
 *
 * Callers must alias the `reports` table as `r` (every current one already does); a fixed alias keeps
 * the fragment free of dynamic identifier interpolation.
 */
export function publicReportFilter(sql: Queryable): SqlFragment {
  return sql`
    r.status = ANY(${[...PUBLIC_REPORT_STATUSES]}::text[])
    AND r.visibility = 'public'
    AND r.deleted_at IS NULL
  `
}

/**
 * "The report's first VISIBLE still" LEFT JOIN LATERAL, aliased `m` (so callers read `m.thumb_key` /
 * `m.r2_key`) and safe to join against a `reports r`.
 *
 * One fragment because it encodes a PREVIEW POLICY that must not drift: only `ready` media is visible to
 * the public (matching findMediaForReport's status rule), and (created_at, id) is a TOTAL order so two
 * assets uploaded in the same millisecond still pick the same one on every render. LEFT so a report with
 * no visible media still yields a row with null keys — no pin is ever dropped for lack of a photo. The
 * service presigns the keys; the repo never signs.
 *
 * WHICH ASSETS CAN STAND IN AS A STILL: an `image` (whose `r2_key` is a usable full-size fallback until
 * its thumb exists) OR any other kind that ALREADY has a poster (`thumb_key IS NOT NULL`) — a
 * transcoded video's poster is a real photo of the problem, and every consumer prefers `thumb_key` over
 * `r2_key`, so a raw .mp4 key can never be handed back as a thumbnail (that WAS the bug the event
 * gallery's hand-rolled copy of this join fixed locally). Keeping the two policies identical is the whole
 * point of the fragment: before this, a video-with-poster report rendered a thumbnail in the event
 * gallery but none on the map pin, in search, or on the post's report card.
 */
export function firstReadyStillLateral(sql: Queryable): SqlFragment {
  return sql`
    LEFT JOIN LATERAL (
      SELECT thumb_key, r2_key
      FROM media_assets
      WHERE report_id = r.id
        AND status = 'ready'
        AND (kind = 'image' OR thumb_key IS NOT NULL)
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    ) m ON true
  `
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
  addr: string | null
  reference_code: string | null
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
    addr: r.addr,
    referenceCode: r.reference_code,
    thumbKey: r.thumb_key,
    r2Key: r.r2_key,
  }
}

// findMapCandidates + searchReports are ~85% identical: same status/visibility gate, same first-visible-
// photo LATERAL preview, same projection. Only the extra WHERE fragments, ORDER BY, and LIMIT differ, so
// they thread in here. The preview join is the shared firstReadyStillLateral fragment above.
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
      r.created_at
    FROM reports r
    ${firstReadyStillLateral(sql)}
    WHERE ${publicReportFilter(sql)}
      ${extraFilters}
    ${order}
    LIMIT ${limit}
  `
  return rows
}
