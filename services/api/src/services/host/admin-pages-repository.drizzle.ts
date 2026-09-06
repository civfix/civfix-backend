import type { EventPageStatus, EventVisibility } from "@civfix/shared"
import type { Sql } from "../../db/client.js"

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
  sortAt: Date
  pageId: string
}

export interface AdminEventPageListParams {
  q?: string
  status?: EventPageStatus
  flagged?: boolean
  cursor: { at: Date; id: string } | null
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

interface PageRowSelect {
  page_id: string
  cleanup_id: string
  slug: string | null
  title: string
  status: EventPageStatus
  visibility: EventVisibility
  organizer_id: string | null
  organizer_name: string | null
  organizer_handle: string | null
  organizer_joined: Date | null
  org_name: string | null
  view_count: string | number
  published_at: Date | null
  flagged_at: Date | null
  flag_reason: string | null
  flagged_by_id: string | null
  flagged_by_name: string | null
  flagged_by_handle: string | null
  flagged_by_joined: Date | null
  sort_at: Date
}

function toRow(row: PageRowSelect): AdminEventPageRow {
  return {
    pageId: row.page_id,
    cleanupId: row.cleanup_id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    visibility: row.visibility,
    organizerId: row.organizer_id,
    organizerName: row.organizer_name,
    organizerHandle: row.organizer_handle,
    organizerJoined: row.organizer_joined,
    orgName: row.org_name,
    viewCount: Number(row.view_count),
    publishedAt: row.published_at,
    flaggedAt: row.flagged_at,
    flagReason: row.flag_reason,
    flaggedById: row.flagged_by_id,
    flaggedByName: row.flagged_by_name,
    flaggedByHandle: row.flagged_by_handle,
    flaggedByJoined: row.flagged_by_joined,
    sortAt: row.sort_at,
  }
}

export function makeDrizzleAdminEventPageRepository(sql: Sql): AdminEventPageRepository {
  const selection = sql`
    p.id AS page_id, p.cleanup_id, c.page_slug AS slug, c.title, p.status, c.visibility,
    u.id AS organizer_id, u.display_name AS organizer_name, u.handle AS organizer_handle,
    u.created_at AS organizer_joined,
    o.name AS org_name, p.view_count, p.published_at, p.flagged_at, p.flag_reason,
    f.id AS flagged_by_id, f.display_name AS flagged_by_name, f.handle AS flagged_by_handle,
    f.created_at AS flagged_by_joined,
    COALESCE(p.published_at, p.updated_at) AS sort_at
  `
  const joins = sql`
    FROM cleanup_pages p
    JOIN cleanups c ON c.id = p.cleanup_id
    LEFT JOIN users u ON u.id = c.organizer_user_id
    LEFT JOIN organizations o ON o.id = c.organization_id AND o.deleted_at IS NULL
    LEFT JOIN users f ON f.id = p.flagged_by
  `

  async function loadOne(cleanupId: string): Promise<AdminEventPageRow | null> {
    const rows = await sql<PageRowSelect[]>`
      SELECT ${selection} ${joins} WHERE p.cleanup_id = ${cleanupId} LIMIT 1`
    const row = rows.at(0)
    return row === undefined ? null : toRow(row)
  }

  return {
    async list(params: AdminEventPageListParams): Promise<AdminEventPageRow[]> {
      const statusFilter = params.status !== undefined ? sql`AND p.status = ${params.status}` : sql``
      const flaggedFilter =
        params.flagged === undefined
          ? sql``
          : params.flagged
            ? sql`AND p.flagged_at IS NOT NULL`
            : sql`AND p.flagged_at IS NULL`
      const search =
        params.q !== undefined && params.q.length > 0
          ? sql`AND (c.title ILIKE ${`%${params.q}%`} OR c.page_slug::text ILIKE ${`%${params.q}%`})`
          : sql``
      const cursorFilter =
        params.cursor !== null
          ? sql`AND (COALESCE(p.published_at, p.updated_at), p.id) < (${params.cursor.at}, ${params.cursor.id}::uuid)`
          : sql``
      const rows = await sql<PageRowSelect[]>`
        SELECT ${selection} ${joins}
         WHERE true
           ${statusFilter}
           ${flaggedFilter}
           ${search}
           ${cursorFilter}
         ORDER BY COALESCE(p.published_at, p.updated_at) DESC, p.id DESC
         LIMIT ${params.limit}`
      return rows.map(toRow)
    },

    get: loadOne,

    async setFlagged(
      cleanupId: string,
      input: { flagged: boolean; reason: string | null; operatorId: string },
    ): Promise<AdminEventPageRow | null> {
      const updated = await sql<{ cleanup_id: string }[]>`
        UPDATE cleanup_pages
           SET flagged_at = ${input.flagged ? sql`now()` : sql`NULL`},
               flagged_by = ${input.flagged ? input.operatorId : null},
               flag_reason = ${input.flagged ? input.reason : null},
               updated_at = now()
         WHERE cleanup_id = ${cleanupId}
     RETURNING cleanup_id`
      return updated.length === 0 ? null : loadOne(cleanupId)
    },

    async unpublish(cleanupId: string): Promise<AdminEventPageRow | null> {
      const updated = await sql<{ cleanup_id: string }[]>`
        UPDATE cleanup_pages
           SET status = 'unpublished', updated_at = now()
         WHERE cleanup_id = ${cleanupId}
     RETURNING cleanup_id`
      return updated.length === 0 ? null : loadOne(cleanupId)
    },
  }
}
