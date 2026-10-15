import type { EventPageStatus, EventVisibility } from "@civfix/shared"
import type { KeysetCursor } from "../../db/cursor-helpers.js"

export interface AdminEventPageRow {
  cleanupId: string
  slug: string | null
  title: string
  status: EventPageStatus
  visibility: EventVisibility
  organizerId: string | null
  organizerName: string | null
  organizerHandle: string | null
  organizerJoined: Date | null
  orgName: string | null
  viewCount: number
  publishedAt: Date | null
  flaggedAt: Date | null
  flagReason: string | null
  flaggedById: string | null
  flaggedByName: string | null
  flaggedByHandle: string | null
  flaggedByJoined: Date | null
  /** COALESCE(published_at, updated_at) at microsecond precision, the list's keyset instant. */
  cursorAt: string
  pageId: string
}

export interface AdminEventPageListParams {
  q?: string
  status?: EventPageStatus
  flagged?: boolean
  cursor: KeysetCursor | null
  limit: number
}

export interface AdminEventPageRepository {
  list(params: AdminEventPageListParams): Promise<AdminEventPageRow[]>
  get(cleanupId: string): Promise<AdminEventPageRow | null>
  setFlagged(
    cleanupId: string,
    input: { flagged: boolean; reason: string | null; operatorId: string },
  ): Promise<AdminEventPageRow | null>
  unpublish(cleanupId: string): Promise<AdminEventPageRow | null>
}
