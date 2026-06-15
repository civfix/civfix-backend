/**
 * Postgres-backed AdminEventRepository (Phase 2): the production binding of the admin events seam.
 *
 * Written against the raw postgres-js tag (`Sql`) like the discovery/reports repos, because every read
 * decodes the cleanup geometry (ST_X/ST_Y) and the list aggregates attendees + the derived flagged state
 * with correlated subqueries. Reads touch cleanups + cleanup_members + cleanup_timeline + chat_messages
 * + users (+ oauth_identities for the derived trust). Mutations run as single transactions so a status
 * change + its cleanup_timeline row never drift.
 *
 * STATUS (H1): cleanups.status is stored in the Phase-1 enum (upcoming|active|done|cancelled); the
 * Phase-2 EventStatus DTO is upcoming|in_progress|completed|cancelled. This repo maps in BOTH directions
 * through services/admin/event-status.ts: every read (eventSelect/toRecord) maps stored -> EventStatus,
 * every write (setStatus) maps EventStatus -> the stored Phase-1 value, and the list status filter
 * matches BOTH the stored value AND any leaked Phase-2 value. So storage stays inside the Phase-1 enum
 * (the drift guard never trips) and a filter never disagrees with a write.
 *
 * FLAGGED: abuse_flags has no `cleanup` subject_type (the frozen Phase 1 enum), so an event's flagged
 * state is tracked in cleanup_timeline (kind 'flag'/'unflag'); flagged = the most recent flag/unflag row
 * is a 'flag'. The list computes it with a correlated "latest flag/unflag kind" subquery.
 *
 * MESSAGE: postMessage inserts a chat_messages row from the operator (sender_id = actorId) + a
 * cleanup_timeline 'message' row, and returns the cleanup_members to notify; notifyMember inserts a
 * notifications row (type 'cleanup_chat'). AUDIT is written in-tx with the operator userId.
 */

import type postgres from "postgres"
import type { Queryable, Sql } from "../../db/client.js"
import { decodeCursor, encodeCursor, clampLimit } from "./pagination.js"
import { writeAudit } from "./audit.js"
import {
  toEventStatus,
  toStoredCleanupStatus,
  storedVariantsForEventStatus,
} from "./event-status.js"
import type {
  AdminEventMessageRecord,
  AdminEventRecord,
  AdminEventRepository,
  AdminEventTimelineRecord,
  AdminOrganizerRecord,
  ListEventsArgs,
} from "./admin-event-service.js"
import type { AdminEventCounts, EventStatus } from "@civfix/shared"

/** A composable SQL fragment (postgres.js Fragment). */
type SqlFragment = postgres.Fragment

/**
 * The "is flagged" boolean: the most recent cleanup_timeline flag/unflag row is a 'flag'. Shared by the
 * flagged facet + countByBucket so they always agree.
 */
function flaggedEventExpr(sql: Queryable): SqlFragment {
  return sql`COALESCE((
    SELECT ct.kind = 'flag'
    FROM cleanup_timeline ct
    WHERE ct.cleanup_id = c.id AND ct.kind IN ('flag', 'unflag')
    ORDER BY ct.created_at DESC, ct.id DESC
    LIMIT 1
  ), false)`
}

/**
 * The event-search predicate (title / address / organizer name+handle, + exact id on a uuid q), shared by
 * listEvents + countByBucket. Assumes the query selects `cleanups c` LEFT JOIN `users u`. Empty when null.
 */
function searchEventsFragment(sql: Queryable, q: string | null): SqlFragment {
  if (q === null) return sql``
  const like = `%${q}%`
  const idBranch = isUuid(q) ? sql`OR c.id = ${q}::uuid` : sql``
  return sql`AND (
    c.title ILIKE ${like}
    OR c.address ILIKE ${like}
    ${idBranch}
    OR u.display_name ILIKE ${like}
    OR (u.handle::text) ILIKE ${like}
  )`
}

/** Max chat messages returned for an event detail. */
const MESSAGE_CAP = 100

/** A cleanups list/detail row as selected back (geom decoded, organizer joined, aggregates computed). */
interface EventRowSelect {
  id: string
  /** Raw stored cleanups.status (Phase-1 enum); mapped to EventStatus in toRecord. */
  status: string
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

/** Project a selected cleanup row into the structural record the service consumes. */
function toRecord(r: EventRowSelect): AdminEventRecord {
  const organizer: AdminOrganizerRecord | null =
    r.organizer_id !== null
      ? {
          id: r.organizer_id,
          name: r.organizer_name ?? "Organizer",
          handle: r.organizer_handle,
          emailVerified: r.organizer_email_verified ?? false,
          hasOauth: r.organizer_has_oauth ?? false,
          joinedAt: r.organizer_joined,
        }
      : null
  return {
    id: r.id,
    // Map the stored Phase-1 cleanups.status -> the Phase-2 EventStatus DTO (H1); defensive so a legacy
    // active/done (or a previously-mis-stored Phase-2 value) never leaks an invalid EventStatus.
    status: toEventStatus(r.status),
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

/**
 * The shared cleanup SELECT (geom decoded, organizer joined, attendees + flagged computed). The
 * `extraWhere`/`orderLimit` clauses narrow it. `flagged` derives from the most recent flag/unflag
 * cleanup_timeline row. `place`/`address`: cleanups carry a free-text `address`; the place label falls
 * back to that address (cleanups are not jurisdiction-scoped in Phase 1).
 */
function eventSelect(
  sql: Queryable,
  extraWhere: SqlFragment,
  orderLimit: SqlFragment,
): SqlFragment {
  return sql`
    SELECT
      c.id,
      c.status,
      COALESCE((
        SELECT ct.kind = 'flag'
        FROM cleanup_timeline ct
        WHERE ct.cleanup_id = c.id AND ct.kind IN ('flag', 'unflag')
        ORDER BY ct.created_at DESC, ct.id DESC
        LIMIT 1
      ), false) AS flagged,
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
      u.id AS organizer_id,
      u.display_name AS organizer_name,
      u.handle AS organizer_handle,
      u.email_verified AS organizer_email_verified,
      EXISTS (SELECT 1 FROM oauth_identities oi WHERE oi.user_id = u.id) AS organizer_has_oauth,
      u.created_at AS organizer_joined
    FROM cleanups c
    LEFT JOIN users u ON u.id = c.organizer_user_id
    WHERE true
    ${extraWhere}
    ${orderLimit}
  `
}

export function makeDrizzleAdminEventRepository(sql: Sql): AdminEventRepository {
  return {
    async listEvents(
      args: ListEventsArgs,
    ): Promise<{ records: AdminEventRecord[]; nextCursor: string | null }> {
      const limit = clampLimit(args.limit)
      const anchor = decodeCursor(args.cursor)

      const conds: SqlFragment[] = []
      if (args.status !== null) {
        // Match BOTH the Phase-1 stored value AND any leaked Phase-2 value (H1), so e.g. filter=completed
        // catches stored 'done' and a mis-stored 'completed'.
        conds.push(sql`AND c.status = ANY(${storedVariantsForEventStatus(args.status)})`)
      }
      if (args.flaggedOnly) conds.push(sql`AND ${flaggedEventExpr(sql)}`)
      // Search (title/address/organizer, + exact id on a uuid q) is shared with countByBucket via
      // searchEventsFragment so the chips and the list always agree.
      if (args.q !== null) conds.push(searchEventsFragment(sql, args.q))
      if (anchor !== null) {
        conds.push(sql`AND (c.scheduled_at, c.id) < (${anchor.createdAt}, ${anchor.id}::uuid)`)
      }
      const extraWhere = conds.reduce<SqlFragment>((acc, c) => sql`${acc} ${c}`, sql``)
      const orderLimit = sql`ORDER BY c.scheduled_at DESC, c.id DESC LIMIT ${limit + 1}`

      const rows = (await eventSelect(sql, extraWhere, orderLimit)) as unknown as EventRowSelect[]
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const records = page.map(toRecord)
      const last = page[page.length - 1]
      const nextCursor =
        hasMore && last ? encodeCursor({ createdAt: last.scheduled_at, id: last.id }) : null
      return { records, nextCursor }
    },

    async countByBucket(args: { q: string | null }): Promise<AdminEventCounts> {
      // One aggregate over the searched cleanups: total + per-EventStatus (matching the stored Phase-1
      // variants, H1) + the orthogonal flagged count (same derivation as the facet, via flaggedEventExpr).
      const search = searchEventsFragment(sql, args.q)
      const rows = await sql<
        { all: string; upcoming: string; in_progress: string; completed: string; flagged: string }[]
      >`
        SELECT
          COUNT(*)::text AS all,
          COUNT(*) FILTER (WHERE c.status = ANY(${storedVariantsForEventStatus("upcoming")}))::text AS upcoming,
          COUNT(*) FILTER (WHERE c.status = ANY(${storedVariantsForEventStatus("in_progress")}))::text AS in_progress,
          COUNT(*) FILTER (WHERE c.status = ANY(${storedVariantsForEventStatus("completed")}))::text AS completed,
          COUNT(*) FILTER (WHERE ${flaggedEventExpr(sql)})::text AS flagged
        FROM cleanups c
        LEFT JOIN users u ON u.id = c.organizer_user_id
        WHERE true
        ${search}
      `
      const r = rows[0]
      return {
        all: Number(r?.all ?? "0"),
        upcoming: Number(r?.upcoming ?? "0"),
        in_progress: Number(r?.in_progress ?? "0"),
        completed: Number(r?.completed ?? "0"),
        flagged: Number(r?.flagged ?? "0"),
      }
    },

    async getEvent(id: string): Promise<AdminEventRecord | null> {
      const rows = (await eventSelect(
        sql,
        sql`AND c.id = ${id}`,
        sql`LIMIT 1`,
      )) as unknown as EventRowSelect[]
      return rows[0] ? toRecord(rows[0]) : null
    },

    async listTimeline(id: string): Promise<AdminEventTimelineRecord[]> {
      const rows = await sql<
        { kind: string; note: string | null; who: string | null; created_at: Date }[]
      >`
        SELECT t.kind, t.note, COALESCE(u.display_name, u.handle) AS who, t.created_at
        FROM cleanup_timeline t
        LEFT JOIN users u ON u.id = t.actor_id
        WHERE t.cleanup_id = ${id}
        ORDER BY t.created_at ASC, t.id ASC
      `
      return rows.map((r) => ({
        kind: r.kind,
        note: r.note,
        who: r.who ?? "system",
        createdAt: r.created_at,
      }))
    },

    async listMessages(id: string): Promise<AdminEventMessageRecord[]> {
      const rows = await sql<{ who: string | null; body: string | null; created_at: Date }[]>`
        SELECT COALESCE(u.display_name, u.handle) AS who, m.body, m.created_at
        FROM chat_messages m
        LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.cleanup_id = ${id} AND m.deleted_at IS NULL
        ORDER BY m.created_at ASC
        LIMIT ${MESSAGE_CAP}
      `
      return rows.map((r) => ({
        who: r.who ?? "system",
        text: r.body ?? "",
        createdAt: r.created_at,
      }))
    },

    async setStatus(
      id: string,
      input: { status: EventStatus; note: string; actorId: string | null },
    ): Promise<boolean> {
      // Map the Phase-2 EventStatus -> the stored Phase-1 cleanups.status value (H1), so the column never
      // holds a value outside the Phase-1 enum the rest of the system + the drift guard expect.
      const stored = toStoredCleanupStatus(input.status)
      return sql.begin(async (tx) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE cleanups SET status = ${stored} WHERE id = ${id} RETURNING id
        `
        if (updated.length === 0) return false
        await tx`
          INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
          VALUES (${id}, 'status', ${input.note}, ${input.actorId})
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "event.status_changed",
          target: `cleanup:${id}`,
          meta: { status: input.status },
        })
        return true
      })
    },

    async setBags(
      id: string,
      input: { bags: number; actorId: string | null },
    ): Promise<boolean> {
      // The only write path for cleanups.bags. UPDATE + audit in one tx; no cleanup_timeline row (the
      // timeline `kind` enum has no 'outcome' value, and the audit log captures the operator action).
      return sql.begin(async (tx) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE cleanups SET bags = ${input.bags} WHERE id = ${id} RETURNING id
        `
        if (updated.length === 0) return false
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "event.outcome_logged",
          target: `cleanup:${id}`,
          meta: { bags: input.bags },
        })
        return true
      })
    },

    async toggleFlag(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<boolean | null> {
      return sql.begin(async (tx) => {
        const exists = await tx<{ id: string }[]>`SELECT id FROM cleanups WHERE id = ${id} LIMIT 1`
        if (exists.length === 0) return null

        const latest = await tx<{ kind: string }[]>`
          SELECT kind FROM cleanup_timeline
          WHERE cleanup_id = ${id} AND kind IN ('flag', 'unflag')
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `
        const currentlyFlagged = latest[0]?.kind === "flag"
        const nowFlagged = !currentlyFlagged
        await tx`
          INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
          VALUES (
            ${id}, ${nowFlagged ? "flag" : "unflag"},
            ${nowFlagged ? "Flagged for review" : "Flag cleared"},
            ${input.actorId}
          )
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: nowFlagged ? "event.flagged" : "event.unflagged",
          target: `cleanup:${id}`,
          meta: { reason: input.reason },
        })
        return nowFlagged
      })
    },

    async cancel(id: string, input: { note: string; actorId: string | null }): Promise<boolean> {
      return sql.begin(async (tx) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE cleanups SET status = 'cancelled' WHERE id = ${id} RETURNING id
        `
        if (updated.length === 0) return false
        await tx`
          INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
          VALUES (${id}, 'cancel', ${input.note}, ${input.actorId})
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "event.cancelled",
          target: `cleanup:${id}`,
          meta: { note: input.note },
        })
        return true
      })
    },

    async postMessage(
      id: string,
      input: { body: string; actorId: string | null },
    ): Promise<{ notified: number } | null> {
      return sql.begin(async (tx) => {
        const exists = await tx<{ id: string }[]>`SELECT id FROM cleanups WHERE id = ${id} LIMIT 1`
        if (exists.length === 0) return null
        // chat_messages.sender_id is NOT NULL: an operator update is posted as the operator. When there is
        // no actor (should not happen on the operator-gated route) we skip the chat row but still record
        // the timeline + fan out notifications, so the update is never lost.
        if (input.actorId !== null) {
          await tx`
            INSERT INTO chat_messages (cleanup_id, sender_id, body, kind)
            VALUES (${id}, ${input.actorId}, ${input.body}, 'text')
          `
        }
        await tx`
          INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
          VALUES (${id}, 'message', 'Posted an update to attendees', ${input.actorId})
        `
        // L4: set-based notification fan-out IN-TX (INSERT ... SELECT), one statement regardless of member
        // count, atomic with the chat message - no partial fan-out, no N+1 round trips. RETURNING counts.
        const notified = await tx<{ user_id: string }[]>`
          INSERT INTO notifications (user_id, type, title, body, link)
          SELECT cm.user_id, 'cleanup_chat', 'Cleanup update', ${input.body}, ${`/cleanups/${id}`}
          FROM cleanup_members cm
          WHERE cm.cleanup_id = ${id}
          RETURNING user_id
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "event.message_posted",
          target: `cleanup:${id}`,
          meta: { members: notified.length },
        })
        return { notified: notified.length }
      })
    },
  }
}

/** Loose uuid shape check so a non-uuid `q` search never trips a Postgres cast error on `q::uuid`. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
