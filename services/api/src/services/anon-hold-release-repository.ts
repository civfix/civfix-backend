import type { LatLng } from "@civfix/shared"

export interface HeldReportView {
  id: string
  reporterUserId: string | null
  anonSessionId: string | null
  status: string
  visibility: string
  lat: number
  lng: number
  deletedAt: Date | null
}

export interface ReleaseMediaView {
  id: string
  status: "validating" | "ready" | "rejected" | "held"
  exifGeo?: LatLng | null
}

export interface AnonHoldReleaseRepository {
  findReport(reportId: string): Promise<HeldReportView | null>
  findMedia(reportId: string): Promise<ReleaseMediaView[]>
  countOpenAbuseFlags(reportId: string, mediaIds: string[]): Promise<number>
  publishHeldReport(reportId: string, publishedAt: Date, mediaIds?: string[]): Promise<boolean>
  findHeldAnonReportIds(limit: number): Promise<string[]>
}
