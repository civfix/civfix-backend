import { latLngToCell } from "h3-js"
import type { ReportCategory, ReportClusterDTO, ReportStatus, ReportType } from "@civfix/shared"
import { REPORT_H3_RESOLUTION, type ReportMapPoint } from "./report-service.types.js"

// Max candidate report points pulled from the DB for a single bbox/cluster query. Bounds the payload and
// per-request work for a wide bbox; clustering then collapses them to far fewer pins.
export const MAP_REPORTS_CANDIDATE_CAP = 2000

// Zoom at/above which the map returns INDIVIDUAL pins; below it points snap to a grid and return as
// clusters with counts. 13 is "neighborhood" zoom (the clients' default landing zoom).
export const CLUSTER_ZOOM_THRESHOLD = 13

// Pure; wraps h3-js. The per-report H3 index stored on each row (reports.h3_cell).
export function reportH3Cell(lat: number, lng: number): string {
  return latLngToCell(lat, lng, REPORT_H3_RESOLUTION)
}

// Map CLUSTER grid cell size in DEGREES (separate from the H3 reports.h3_cell). Halves each zoom step so
// the world stays partitioned into ~constant screen-space tiles.
export function clusterCellSizeDeg(zoom: number): number {
  // Defense-in-depth NaN/non-finite guard: a non-finite zoom would yield a NaN cell size -> every point
  // maps to a "NaN:NaN" grid key -> one cluster at NaN coords (serializes to null = a broken pin). Treat a
  // non-finite zoom as 0 (the coarsest cell). The route additionally rejects a bad zoom with 422 first.
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
    thumbKey: p.thumbKey,
    r2Key: p.r2Key,
  }
}

// PURE server-side clustering keyed by zoom. At/above CLUSTER_ZOOM_THRESHOLD: every point becomes an
// individual (unsigned) pin. Below it: points snap to a clusterCellSizeDeg grid, one ReportClusterDTO per
// non-empty cell at the cell centroid with a count. Deterministic (cells iterated in insertion order) so
// tests can assert exact output.
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
    clusters.push({ lat: cell.latSum / cell.count, lng: cell.lngSum / cell.count, count: cell.count })
  }
  return { clusters, pins: [] }
}

// Per-category count over ALL candidates (independent of the cluster/pin split) so the filter popover
// shows how many reports of each category are in view. Only non-zero categories are present.
export function countByCategory(points: ReportMapPoint[]): Partial<Record<ReportCategory, number>> {
  const counts: Partial<Record<ReportCategory, number>> = {}
  for (const p of points) {
    counts[p.category] = (counts[p.category] ?? 0) + 1
  }
  return counts
}
