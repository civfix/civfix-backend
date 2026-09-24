import type { BroadcastKind, BroadcastSegment } from "@civfix/shared"
import type postgres from "postgres"
import type { Queryable } from "../../db/client.js"
import { CRITICAL_BROADCAST_KINDS, HOST_COMPOSED_BROADCAST_KINDS } from "./broadcast-types.js"
import type { AudienceCountQuery, AudiencePageQuery } from "./broadcast-repository.js"
import type { BroadcastAudienceRepository } from "./broadcast-audience-repository.js"

// Sorts before every real id, so a first page starts at the beginning of the keyset.
const FIRST_UUID = "00000000-0000-0000-0000-000000000000"

export interface AudienceQuery {
  cleanupId: string
  segment: BroadcastSegment
  kind: BroadcastKind
  after: string | null
  limit: number
}

interface IdRow {
  id: string
}

type AudienceStatement = postgres.PendingQuery<IdRow[]>

interface CountRow {
  n: number
}

async function listMemberAudiencePage(sql: Queryable, query: AudienceQuery): Promise<string[]> {
  const page = memberQuery(sql, query)
  const rows = page === null ? [] : await page
  return rows.map((row) => row.id)
}

async function listGuestAudiencePage(sql: Queryable, query: AudienceQuery): Promise<string[]> {
  const page = guestQuery(sql, query)
  const rows = page === null ? [] : await page
  return rows.map((row) => row.id)
}

// Wraps the same statement a send pages through, so the preview count and the send share one predicate.
async function countAudienceSide(sql: Queryable, page: AudienceStatement | null): Promise<number> {
  if (page === null) return 0
  const [row] = await sql<CountRow[]>`SELECT count(*)::int AS n FROM (${page}) s`
  return row?.n ?? 0
}

export function makeDrizzleBroadcastAudienceRepository(
  sql: Queryable,
): BroadcastAudienceRepository {
  return {
    async audiencePage(query: AudiencePageQuery): Promise<{ members: string[]; guests: string[] }> {
      const [members, guests] = await Promise.all([
        listMemberAudiencePage(sql, {
          cleanupId: query.cleanupId,
          segment: query.segment,
          kind: query.kind,
          after: query.afterMember,
          limit: query.limit,
        }),
        listGuestAudiencePage(sql, {
          cleanupId: query.cleanupId,
          segment: query.segment,
          kind: query.kind,
          after: query.afterGuest,
          limit: query.limit,
        }),
      ])
      return { members, guests }
    },

    async audienceCount(query: AudienceCountQuery): Promise<number> {
      const side: AudienceQuery = {
        cleanupId: query.cleanupId,
        segment: query.segment,
        kind: query.kind,
        after: null,
        limit: query.cap,
      }
      const [members, guests] = await Promise.all([
        countAudienceSide(sql, memberQuery(sql, side)),
        countAudienceSide(sql, guestQuery(sql, side)),
      ])
      return members + guests
    },
  }
}

function memberSuppressionTail(sql: Queryable, cleanupId: string, kind: BroadcastKind) {
  const hostComposedOptOut = HOST_COMPOSED_BROADCAST_KINDS.has(kind)
    ? sql`
        AND NOT EXISTS (
          SELECT 1 FROM notification_prefs np
           WHERE np.user_id = u.id AND np.host_broadcasts = false)`
    : sql``
  const optOuts = CRITICAL_BROADCAST_KINDS.has(kind)
    ? sql``
    : sql`
        AND NOT EXISTS (
          SELECT 1 FROM broadcast_unsubscribes bu
           WHERE bu.subject_kind = 'user' AND bu.user_id = u.id
             AND (bu.scope = 'global' OR bu.cleanup_id = ${cleanupId}))
        AND NOT EXISTS (
          SELECT 1 FROM cleanup_broadcast_mutes cbm
           WHERE cbm.cleanup_id = ${cleanupId} AND cbm.user_id = u.id)
        ${hostComposedOptOut}`
  return sql`
       AND u.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM user_moderation um
          WHERE um.user_id = u.id AND um.account_status <> 'active')
       AND NOT EXISTS (
         SELECT 1 FROM cleanup_bans cb
          WHERE cb.cleanup_id = ${cleanupId} AND cb.user_id = u.id)
       ${optOuts}`
}

function guestSuppressionTail(sql: Queryable, cleanupId: string, kind: BroadcastKind) {
  const optOuts = CRITICAL_BROADCAST_KINDS.has(kind)
    ? sql``
    : sql`
        AND NOT EXISTS (
          SELECT 1 FROM broadcast_unsubscribes bu
           WHERE bu.subject_kind = 'guest' AND bu.guest_id = g.id
             AND (bu.scope = 'global' OR bu.cleanup_id = ${cleanupId}))`
  return sql`
       AND g.cancelled_at IS NULL
       AND g.contact_scrubbed_at IS NULL
       AND g.email IS NOT NULL
       ${optOuts}`
}

function memberQuery(sql: Queryable, q: AudienceQuery): AudienceStatement | null {
  const tail = memberSuppressionTail(sql, q.cleanupId, q.kind)
  const after = q.after ?? FIRST_UUID
  switch (q.segment.kind) {
    case "all_registered":
      return sql<IdRow[]>`
        SELECT DISTINCT u.id
          FROM cleanup_registrations r
          JOIN users u ON u.id = r.user_id
         WHERE r.cleanup_id = ${q.cleanupId} AND r.status = 'registered' AND u.id > ${after}
           ${tail}
         ORDER BY u.id
         LIMIT ${q.limit}`
    case "ticket_types":
      return sql<IdRow[]>`
        SELECT DISTINCT u.id
          FROM cleanup_registrations r
          JOIN users u ON u.id = r.user_id
         WHERE r.cleanup_id = ${q.cleanupId} AND r.status = 'registered'
           AND r.ticket_type_id = ANY(${[...q.segment.ids]}::uuid[]) AND u.id > ${after}
           ${tail}
         ORDER BY u.id
         LIMIT ${q.limit}`
    case "slots":
      return sql<IdRow[]>`
        SELECT DISTINCT u.id
          FROM cleanup_slot_claims sc
          JOIN users u ON u.id = sc.user_id
         WHERE sc.cleanup_id = ${q.cleanupId}
           AND sc.slot_id = ANY(${[...q.segment.ids]}::uuid[]) AND u.id > ${after}
           ${tail}
         ORDER BY u.id
         LIMIT ${q.limit}`
    case "waitlist":
      return sql<IdRow[]>`
        SELECT DISTINCT u.id
          FROM cleanup_waitlist w
          JOIN users u ON u.id = w.user_id
         WHERE w.cleanup_id = ${q.cleanupId} AND w.status IN ('waiting','offered')
           AND u.id > ${after}
           ${tail}
         ORDER BY u.id
         LIMIT ${q.limit}`
    case "checked_in":
      return sql<IdRow[]>`
        SELECT DISTINCT u.id
          FROM cleanup_registrations r
          JOIN users u ON u.id = r.user_id
         WHERE r.cleanup_id = ${q.cleanupId} AND r.status = 'registered' AND u.id > ${after}
           AND EXISTS (
             SELECT 1 FROM cleanup_registration_seats s
              WHERE s.registration_id = r.id AND s.status = 'active' AND s.checked_in_at IS NOT NULL)
           ${tail}
         ORDER BY u.id
         LIMIT ${q.limit}`
    case "not_checked_in":
      return sql<IdRow[]>`
        SELECT DISTINCT u.id
          FROM cleanup_registrations r
          JOIN users u ON u.id = r.user_id
         WHERE r.cleanup_id = ${q.cleanupId} AND r.status = 'registered' AND u.id > ${after}
           AND NOT EXISTS (
             SELECT 1 FROM cleanup_registration_seats s
              WHERE s.registration_id = r.id AND s.status = 'active' AND s.checked_in_at IS NOT NULL)
           ${tail}
         ORDER BY u.id
         LIMIT ${q.limit}`
    case "guests_only":
      return null
  }
}

function guestQuery(sql: Queryable, q: AudienceQuery): AudienceStatement | null {
  const tail = guestSuppressionTail(sql, q.cleanupId, q.kind)
  const after = q.after ?? FIRST_UUID
  switch (q.segment.kind) {
    case "all_registered":
    case "guests_only":
      return sql<IdRow[]>`
        SELECT g.id
          FROM cleanup_guests g
         WHERE g.cleanup_id = ${q.cleanupId} AND g.id > ${after}
           ${tail}
         ORDER BY g.id
         LIMIT ${q.limit}`
    case "ticket_types":
      return sql<IdRow[]>`
        SELECT DISTINCT g.id
          FROM cleanup_registrations r
          JOIN cleanup_guests g ON g.id = r.guest_id
         WHERE r.cleanup_id = ${q.cleanupId} AND r.status = 'registered'
           AND r.ticket_type_id = ANY(${[...q.segment.ids]}::uuid[]) AND g.id > ${after}
           ${tail}
         ORDER BY g.id
         LIMIT ${q.limit}`
    case "waitlist":
      return sql<IdRow[]>`
        SELECT DISTINCT g.id
          FROM cleanup_waitlist w
          JOIN cleanup_guests g ON g.id = w.guest_id
         WHERE w.cleanup_id = ${q.cleanupId} AND w.status IN ('waiting','offered')
           AND g.id > ${after}
           ${tail}
         ORDER BY g.id
         LIMIT ${q.limit}`
    case "checked_in":
      return sql<IdRow[]>`
        SELECT DISTINCT g.id
          FROM cleanup_registrations r
          JOIN cleanup_guests g ON g.id = r.guest_id
         WHERE r.cleanup_id = ${q.cleanupId} AND r.status = 'registered' AND g.id > ${after}
           AND EXISTS (
             SELECT 1 FROM cleanup_registration_seats s
              WHERE s.registration_id = r.id AND s.status = 'active' AND s.checked_in_at IS NOT NULL)
           ${tail}
         ORDER BY g.id
         LIMIT ${q.limit}`
    case "not_checked_in":
      return sql<IdRow[]>`
        SELECT DISTINCT g.id
          FROM cleanup_registrations r
          JOIN cleanup_guests g ON g.id = r.guest_id
         WHERE r.cleanup_id = ${q.cleanupId} AND r.status = 'registered' AND g.id > ${after}
           AND NOT EXISTS (
             SELECT 1 FROM cleanup_registration_seats s
              WHERE s.registration_id = r.id AND s.status = 'active' AND s.checked_in_at IS NOT NULL)
           ${tail}
         ORDER BY g.id
         LIMIT ${q.limit}`
    case "slots":
      return null
  }
}
