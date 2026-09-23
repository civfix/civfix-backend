import { latLngToCell } from "h3-js"
import type { ReportCategory, ReportClusterDTO, ReportStatus, ReportType } from "@civfix/shared"
import { REPORT_H3_RESOLUTION, type ReportMapPoint } from "./report-service.types.js"

// Bounds the payload and per-request work for a wide bbox; clustering then collapses them to far fewer pins.
export const MAP_REPORTS_CANDIDATE_CAP = 2000

// Zoom at/above which the map returns INDIVIDUAL pins; below it points snap to a grid and return as
// clusters with counts. 10 is "city" zoom: with the bbox clamp below, a phone-sized viewport (whose
// fetch bbox is padded 1.6x per axis) clears it from map zoom ~9.2 (the whole LA basin in view), so the
// CLIENT clusterer owns every grouping decision from there in and the server only aggregates at the
// aerial scale where a pin payload would be unbounded anyway.
export const CLUSTER_ZOOM_THRESHOLD = 10

/**
 * The bbox, not the client, decides the effective zoom.
 *
 * `zoom` arrives as a FREE query parameter that was never correlated with `bbox`, so an anonymous
 * caller sent `bbox=<whole world>&zoom=22`, skipped clustering entirely, and forced 2000 full report
 * rows plus 2000 media presign round-trips per request, with the 60s Cache-Control defeated by
 * jittering the bbox by a metre. Zoom and viewport extent are not independent in any real map client:
 * a Web-Mercator viewport `W` pixels wide at zoom `z` shows `360 * (W/256) / 2^z` degrees of longitude.
 * Inverting that gives the zoom a given span actually implies, and we take the MINIMUM of that and what
 * the client asked for. A client can still ask to be zoomed further OUT than its viewport (harmless:
 * that only coarsens clustering); it can no longer claim street-level zoom over a continent.
 *
 * The reference viewport is deliberately generous (2048 CSS px ≈ 8 tiles) so that a genuine desktop map
 * is never down-clamped: reaching CLUSTER_ZOOM_THRESHOLD still only requires a span of
 * 360*8/2^10 ≈ 2.81° (~280 km), which is a real metro-area viewport, while a world bbox tops out at
 * an implied zoom of 3 and can therefore NEVER reach the per-pin branch. MAP_REPORTS_CANDIDATE_CAP
 * still bounds the pin payload at 2000 rows, and the route's 60s Cache-Control is unchanged.
 */
export const MAP_VIEWPORT_REFERENCE_TILES = 8

export interface MapBBox {
  west: number
  south: number
  east: number
  north: number
}

/** The largest zoom a viewport of this extent could plausibly be displaying. */
export function impliedZoomForBBox(bbox: MapBBox): number {
  const lngSpan = bbox.east - bbox.west
  // Latitude runs over a 180° axis where longitude runs over 360°, so double it before comparing.
  const latSpan = (bbox.north - bbox.south) * 2
  // The route already rejects west >= east, but a zero span would send log2 to +Infinity, i.e. no clamp.
  const span = Math.max(lngSpan, latSpan)
  if (!Number.isFinite(span) || span <= 0) return 0
  const z = Math.log2((360 * MAP_VIEWPORT_REFERENCE_TILES) / span)
  if (!Number.isFinite(z)) return 0
  return Math.max(0, Math.min(22, Math.floor(z)))
}

export function effectiveMapZoom(bbox: MapBBox, requestedZoom: number): number {
  const requested = Number.isFinite(requestedZoom) ? requestedZoom : 0
  return Math.min(requested, impliedZoomForBBox(bbox))
}

export function reportH3Cell(lat: number, lng: number): string {
  return latLngToCell(lat, lng, REPORT_H3_RESOLUTION)
}

// Separate from the H3 reports.h3_cell. Halves each zoom step so the world stays partitioned into
// ~constant screen-space tiles.
export function clusterCellSizeDeg(zoom: number): number {
  // The route rejects a bad zoom first, but a non-finite one here would put every point in one cluster
  // at NaN coords, which serializes to null (a broken pin).
  const safeZoom = Number.isFinite(zoom) ? zoom : 0
  const z = Math.max(0, Math.floor(safeZoom))
  return 360 / Math.pow(2, z + 1)
}

// An individual pin BEFORE its thumbnail is presigned. clusterByZoom is pure/sync and cannot reach the
// async Storage seam, so each pin carries the report's first-media keys; the service presigns them.
export interface UnsignedReportPin {
  id: string
  category: ReportCategory
  type: ReportType
  lat: number
  lng: number
  status: ReportStatus
  title: string | null
  description: string | null
  addr: string | null
  referenceCode: string | null
  thumbKey: string | null
  r2Key: string | null
}

export function mapPointToUnsignedPin(p: ReportMapPoint): UnsignedReportPin {
  return {
    id: p.id,
    category: p.category,
    type: p.type,
    lat: p.lat,
    lng: p.lng,
    status: p.status,
    title: p.title,
    description: p.description,
    addr: p.addr,
    referenceCode: p.referenceCode,
    thumbKey: p.thumbKey,
    r2Key: p.r2Key,
  }
}

// Cells are iterated in insertion order so the output is deterministic and tests can assert it exactly.
export function clusterByZoom(
  points: ReportMapPoint[],
  zoom: number,
): { clusters: ReportClusterDTO[]; pins: UnsignedReportPin[] } {
  if (zoom >= CLUSTER_ZOOM_THRESHOLD) {
    return { clusters: [], pins: points.map(mapPointToUnsignedPin) }
  }

  const size = clusterCellSizeDeg(zoom)
  const cells = new Map<string, { latSum: number; lngSum: number; count: number }>()
  for (const p of points) {
    const gx = Math.floor(p.lng / size)
    const gy = Math.floor(p.lat / size)
    const key = `${gx}:${gy}`
    const cell = cells.get(key)
    if (cell) {
      cell.latSum += p.lat
      cell.lngSum += p.lng
      cell.count += 1
    } else {
      cells.set(key, { latSum: p.lat, lngSum: p.lng, count: 1 })
    }
  }

  const clusters: ReportClusterDTO[] = []
  for (const cell of cells.values()) {
    clusters.push({
      lat: cell.latSum / cell.count,
      lng: cell.lngSum / cell.count,
      count: cell.count,
    })
  }
  return { clusters, pins: [] }
}

// Counts ALL candidates, independent of the cluster/pin split, so the filter popover shows how many
// reports of each category are in view.
export function countByCategory(points: ReportMapPoint[]): Partial<Record<ReportCategory, number>> {
  const counts: Partial<Record<ReportCategory, number>> = {}
  for (const p of points) {
    counts[p.category] = (counts[p.category] ?? 0) + 1
  }
  return counts
}
