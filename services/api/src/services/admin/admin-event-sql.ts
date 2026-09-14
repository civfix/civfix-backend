// Composable SQL fragments + the row->record projector for the Drizzle admin-event repo. Extracted so the
// repo file holds query orchestration only and the flagged/search expressions have ONE definition each.

import type { Queryable } from "../../db/client.js"
import { isUuid } from "../../db/cursor-helpers.js"
import { ilikeAnyOf, type SqlFragment } from "./sql-fragments.js"
import { personSelect, toPersonRecord } from "./admin-person.js"
import { toEventStatus } from "./event-status.js"
import type { AdminEventRecord, AdminOrganizerRecord } from "./admin-event-service.js"
import type { EventKind } from "@civfix/shared"
import { adminEventStatusExpr } from "../cleanup-sql.js"

// The "is flagged" boolean: the most recent cleanup_timeline flag/unflag row is a 'flag'. The ONE
// definition — eventSelect + countByBucket both build their flagged column/filter from this so they can't
// drift.
export function flaggedEventExpr(sql: Queryable): SqlFragment {
  return sql`COALESCE((
    SELECT ct.kind = 'flag'
    FROM cleanup_timeline ct
    WHERE ct.cleanup_id = c.id AND ct.kind IN ('flag', 'unflag')
    ORDER BY ct.created_at DESC, ct.id DESC
    LIMIT 1
  ), false)`
}

// The event-search predicate (title / address / organizer name+handle, + exact id on a uuid q), shared by
// listEvents + countByBucket. Assumes the query selects `cleanups c` LEFT JOIN `users u`. Empty when null.
export function searchEventsFragment(sql: Queryable, q: string | null): SqlFragment {
  if (q === null) return sql``
  // ilikeAnyOf escapes the LIKE metacharacters so %/_ in q match literally (wildcard injection/trigram DoS).
  return sql`AND ${ilikeAnyOf(
    sql,
    [sql`c.title`, sql`c.address`, sql`u.display_name`, sql`u.handle::text`],
    q,
    isUuid(q) ? [sql`c.id = ${q}::uuid`] : [],
  )}`
}

// A cleanups list/detail row as selected back (geom decoded, organizer joined, aggregates computed).
export interface EventRowSelect {
  id: string
  // Raw stored cleanups.status (Phase-1 enum); mapped to EventStatus in toRecord.
  status: string
  event_kind: EventKind
  flagged: boolean
  title: string | null
  place: string | null
  address: string | null
  description: string | null
  attendees: string
  capacity: number | null
  bags: number
  lat: number
  lng: number
  scheduled_at: Date
  organizer_id: string | null
  organizer_name: string | null
  organizer_handle: string | null
  organizer_email_verified: boolean | null
  organizer_has_oauth: boolean | null
  organizer_joined: Date | null
}

export function toRecord(r: EventRowSelect): AdminEventRecord {
  const organizer: AdminOrganizerRecord | null = toPersonRecord(
    {
      id: r.organizer_id,
      name: r.organizer_name,
      handle: r.organizer_handle,
      emailVerified: r.organizer_email_verified,
      hasOauth: r.organizer_has_oauth,
      joinedAt: r.organizer_joined,
    },
    "Organizer",
  )
  return {
    id: r.id,
    // Map the stored Phase-1 cleanups.status -> the Phase-2 EventStatus DTO (H1); defensive so a legacy
    // active/done (or a previously-mis-stored Phase-2 value) never leaks an invalid EventStatus.
    status: toEventStatus(r.status),
    eventKind: r.event_kind,
    flagged: r.flagged,
    title: r.title ?? "Cleanup",
    place: r.place ?? "",
    attendees: Number(r.attendees ?? "0"),
    capacity: r.capacity,
    bags: r.bags,
    organizer,
    desc: r.description ?? "",
    address: r.address ?? "",
    lat: r.lat,
    lng: r.lng,
    scheduledAt: r.scheduled_at,
  }
}

// The shared cleanup SELECT (geom decoded, organizer joined, attendees + flagged computed). `extraWhere`/
// `orderLimit` narrow it. `place`/`address`: cleanups carry a free-text `address`; the place label falls
// back to that address (cleanups are not jurisdiction-scoped in Phase 1).
export function eventSelect(
  sql: Queryable,
  extraWhere: SqlFragment,
  orderLimit: SqlFragment,
): SqlFragment {
  return sql`
    SELECT
      c.id,
      ${adminEventStatusExpr(sql)} AS status,
      c.event_kind,
      ${flaggedEventExpr(sql)} AS flagged,
      c.title,
      c.address AS place,
      c.address,
      c.description,
      (SELECT COUNT(*) FROM cleanup_members cm WHERE cm.cleanup_id = c.id)::text AS attendees,
      c.capacity,
      c.bags,
      ST_Y(c.geom) AS lat,
      ST_X(c.geom) AS lng,
      c.scheduled_at,
      ${personSelect(sql, "u", "organizer")}
    FROM cleanups c
    LEFT JOIN users u ON u.id = c.organizer_user_id
    WHERE true
    ${extraWhere}
    ${orderLimit}
  `
}
