/**
 * User-activity service: assembles a person's PUBLIC activity history (reports created, events hosted,
 * events attended, comments made, people followed) for the expanded profile's Activity list.
 *
 * All DB access sits behind the UserActivityRepository seam (Drizzle impl in
 * user-activity-repository.drizzle.ts) so the service is unit-testable with no database. The repo runs a
 * keyset-paginated UNION across the sources; this service only clamps the page size and maps records to
 * the wire DTO + the next cursor.
 *
 * PRIVACY (enforced in the repository query, restated here): the feed NEVER surfaces direct messages,
 * blocks, private message bodies, anonymous reports, or held/hidden/removed content — only public,
 * user-attributable actions.
 */

import type {
  UserActivityItemDTO,
  UserActivityKind,
  UserActivityListResponse,
} from "@civfix/shared"
import { clampLimit, decodeCursor, paginate } from "./admin/pagination.js"

/** Default page size for the activity list when the request omits `limit`. */
export const USER_ACTIVITY_DEFAULT_LIMIT = 25

/** A normalized activity row the repo returns (one entry per source row). */
export interface UserActivityRecord {
  id: string
  kind: UserActivityKind
  at: Date
  title: string | null
  subtitle: string | null
  refKind: "report" | "event" | "person" | null
  refId: string | null
}

export interface UserActivityRepository {
  /**
   * Page a user's public activity, newest first, keyset-paginated. `limit` is the page size; the repo
   * fetches `limit + 1` to detect a next page. `cursor` is the decoded "<iso>|<id>" anchor (null = first
   * page). Returns up to `limit + 1` records ordered by (at DESC, id DESC).
   */
  listActivity(args: {
    userId: string
    cursor: { createdAt: Date; id: string } | null
    limit: number
  }): Promise<UserActivityRecord[]>
}

export interface UserActivityServiceDeps {
  repo: UserActivityRepository
}

export interface UserActivityService {
  list(userId: string, cursor: string | null, limit: number | undefined): Promise<UserActivityListResponse>
}

/** Project a record into the wire DTO (omitting null optionals to keep the payload tidy). */
function toItem(r: UserActivityRecord): UserActivityItemDTO {
  return {
    id: r.id,
    kind: r.kind,
    at: r.at.toISOString(),
    ...(r.title !== null ? { title: r.title } : {}),
    ...(r.subtitle !== null ? { subtitle: r.subtitle } : {}),
    ...(r.refKind !== null ? { refKind: r.refKind } : {}),
    ...(r.refId !== null ? { refId: r.refId } : {}),
  }
}

export function makeUserActivityService(deps: UserActivityServiceDeps): UserActivityService {
  return {
    async list(
      userId: string,
      cursor: string | null,
      limit: number | undefined,
    ): Promise<UserActivityListResponse> {
      const n = clampLimit(limit ?? USER_ACTIVITY_DEFAULT_LIMIT)
      // requireUuidId=false: the repo's keyset compares the cursor id against `id::text` (the UNION mixes
      // report/cleanup/person ids), never `::uuid`, so a non-UUID id is safe — do NOT "tidy" this to true.
      const anchor = decodeCursor(cursor, false)
      const rows = await deps.repo.listActivity({ userId, cursor: anchor, limit: n })
      const { items, nextCursor } = paginate(rows, n, (r) => ({ createdAt: r.at, id: r.id }))
      return { items: items.map(toItem), nextCursor }
    },
  }
}
