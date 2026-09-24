/**
 * Joins seeded demo users to one existing event the way the live join path does, including its refusals
 * (closed events, banned users, RSVP capacity) and the free registration + seat on unticketed events.
 * Only accounts on the reserved demo domain are ever touched, so this cannot RSVP a real user.
 *
 * SAFETY: the default run is a rehearsal (one transaction, printed, then rolled back). Pass --yes to
 * commit.
 *
 * The seat token hash is keyed by TICKET_TOKEN_SECRET, resolved exactly as the API resolves it (the
 * development fallback included), or the demo seats will not scan at check-in; the api container
 * already carries it.
 *
 * Usage (inside the api container, or anywhere with DATABASE_URL and TICKET_TOKEN_SECRET):
 *   node dist/db/demo-join-event.js --event 1695-000006            # rehearse
 *   node dist/db/demo-join-event.js --event 1695-000006 --yes      # commit
 *   --event accepts the EVENT reference code with or without the "EVENT-" prefix, or the cleanup's
 *   uuid. Optional: --count N (default 15), --seed N (PRNG seed, default 20260902).
 */

import type { TransactionSql } from "./client.js"
import { argValue, requireDatabaseUrl, runDbCli, runIfMain } from "./cli.js"
import { isUuid } from "./cursor-helpers.js"
import { EVENT_PREFIX } from "./reference-code.js"
import { DEMO_EMAIL_DOMAIN, DEMO_EMAIL_PATTERN } from "./seed-demo-domain.js"
import { demoTicketTokenHasher, mintDemoSignupSeats } from "./demo-signup-seats.js"
import { DEMO_PRNG_SEED, chance, rand, rint, seedDemoRandom, shuffle } from "./demo-random.js"
import { deriveCleanupStatus, eventWindowOf } from "../services/cleanup-rules.js"
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from "../lib/time.js"

const DEFAULT_JOIN_COUNT = 15
const MAX_JOIN_COUNT = 200
const SLOT_CLAIM_PROBABILITY = 0.45

// RSVPs start after the event existed; the spread is capped at the last 5 days so it reads like a burst
// of signups rather than rows backdated before the event was announced. The start is clamped to at
// least 12h ago so an event with a bogus/near-future created_at still yields a spread of past join
// times instead of a one-minute cluster.
const RSVP_SPREAD_MS = 5 * MS_PER_DAY
const MIN_RSVP_LOOKBACK_MS = 12 * MS_PER_HOUR

/** Biased toward the recent end, because RSVPs cluster after a promo post. */
function joinTimestamp(start: Date, now: Date): Date {
  const span = Math.max(now.getTime() - start.getTime(), MS_PER_MINUTE)
  const t = new Date(now.getTime() - Math.pow(rand(), 2) * span)
  t.setUTCMinutes(rint(0, 59), rint(0, 59), 0)
  // The minute/second jitter can overshoot either bound; clamp inside (start, now).
  if (t.getTime() >= now.getTime()) return new Date(now.getTime() - rint(2, 45) * MS_PER_MINUTE)
  if (t.getTime() <= start.getTime()) return new Date(start.getTime() + MS_PER_MINUTE)
  return t
}

function rsvpWindowStart(createdAt: Date, now: Date): Date {
  return new Date(
    Math.min(
      Math.max(createdAt.getTime(), now.getTime() - RSVP_SPREAD_MS),
      now.getTime() - MIN_RSVP_LOOKBACK_MS,
    ),
  )
}

interface EventRow {
  id: string
  title: string
  status: string
  scheduled_at: Date
  ends_at: Date
  created_at: Date
  capacity: number | null
  organizer_user_id: string
}

interface MemberRow {
  cleanup_id: string
  user_id: string
  role: string
  joined_at: Date
}

async function loadEvent(tx: TransactionSql, ref: string): Promise<EventRow | null> {
  if (isUuid(ref)) {
    const rows = await tx<EventRow[]>`
      SELECT id, title, status, scheduled_at, ends_at, created_at, capacity, organizer_user_id
      FROM cleanups WHERE id = ${ref} LIMIT 1
    `
    return rows[0] ?? null
  }
  const upper = ref.toUpperCase()
  const code = upper.startsWith(`${EVENT_PREFIX}-`) ? upper : `${EVENT_PREFIX}-${ref}`
  const rows = await tx<EventRow[]>`
    SELECT id, title, status, scheduled_at, ends_at, created_at, capacity, organizer_user_id
    FROM cleanups WHERE reference_code = ${code} LIMIT 1
  `
  return rows[0] ?? null
}

/** Takes the same lock the live join takes, so a concurrent cancel/complete cannot race the join. */
async function loadJoinableEvent(tx: TransactionSql, eventRef: string): Promise<EventRow> {
  const event = await loadEvent(tx, eventRef)
  if (!event) throw new Error(`event not found for "${eventRef}"`)
  await tx`SELECT status FROM cleanups WHERE id = ${event.id} FOR SHARE`
  const derived = deriveCleanupStatus(
    eventWindowOf({
      status: event.status === "cancelled" ? "cancelled" : "upcoming",
      scheduledAt: event.scheduled_at,
      endsAt: event.ends_at,
    }),
    Date.now(),
  )
  if (derived === "done" || derived === "cancelled") {
    throw new Error(
      `event "${event.title}" is ${derived}; the live join path refuses closed events`,
    )
  }
  console.log(`event: ${event.title} (${derived}, scheduled ${event.scheduled_at.toISOString()})`)
  return event
}

async function eligibleDemoUsers(
  tx: TransactionSql,
  event: EventRow,
): Promise<{ id: string; handle: string; created_at: Date }[]> {
  const candidates = await tx<{ id: string; handle: string; created_at: Date }[]>`
          SELECT u.id, u.handle, u.created_at
          FROM users u
          WHERE u.email LIKE ${DEMO_EMAIL_PATTERN}
            AND u.deleted_at IS NULL
            AND u.id <> ${event.organizer_user_id}
            AND NOT EXISTS (SELECT 1 FROM cleanup_members m WHERE m.cleanup_id = ${event.id} AND m.user_id = u.id)
            AND NOT EXISTS (SELECT 1 FROM cleanup_bans b WHERE b.cleanup_id = ${event.id} AND b.user_id = u.id)
        `
  if (candidates.length === 0) {
    throw new Error(`no eligible demo users found (@${DEMO_EMAIL_DOMAIN}); run seed-demo-la first`)
  }
  return candidates
}

/** The same sum the cleanup repository's goingCount measures: members plus non-cancelled guests. */
async function goingCount(tx: TransactionSql, eventId: string): Promise<number> {
  const [going] = await tx<{ n: number }[]>`
            SELECT (SELECT count(*)::int FROM cleanup_members m WHERE m.cleanup_id = ${eventId})
                 + (SELECT count(*)::int FROM cleanup_guests g
                    WHERE g.cleanup_id = ${eventId} AND g.cancelled_at IS NULL) AS n
          `
  return Number(going?.n ?? 0)
}

async function remainingRoom(tx: TransactionSql, event: EventRow): Promise<number> {
  if (event.capacity === null) return Number.POSITIVE_INFINITY
  const room = Math.max(0, event.capacity - (await goingCount(tx, event.id)))
  if (room === 0) throw new Error(`event is at capacity (${event.capacity}); nothing to do`)
  return room
}

async function claimDemoSlots(
  tx: TransactionSql,
  eventId: string,
  memberRows: readonly MemberRow[],
): Promise<number> {
  const slots = await tx<{ id: string; title: string; capacity: number | null; claims: number }[]>`
          SELECT s.id, s.title, s.capacity,
                 (SELECT count(*)::int FROM cleanup_slot_claims c WHERE c.slot_id = s.id) AS claims
          FROM cleanup_slots s WHERE s.cleanup_id = ${eventId}
          ORDER BY s.sort_order, s.id
        `
  if (slots.length === 0) return 0
  let claimed = 0
  const open = slots.map((s) => ({ ...s, claims: Number(s.claims) }))
  for (const m of memberRows) {
    if (!chance(SLOT_CLAIM_PROBABILITY)) continue
    const slot = shuffle(open.filter((s) => s.capacity === null || s.claims < s.capacity))[0]
    if (!slot) break
    slot.claims++
    claimed++
    await tx`
              INSERT INTO cleanup_slot_claims (cleanup_id, user_id, slot_id, claimed_at)
              VALUES (${eventId}, ${m.user_id}, ${slot.id}, ${new Date(m.joined_at.getTime() + rint(1, 30) * MS_PER_MINUTE)})
              ON CONFLICT (cleanup_id, user_id) DO NOTHING
            `
  }
  return claimed
}

async function verifyJoin(tx: TransactionSql, event: EventRow): Promise<void> {
  const [overCap] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM cleanup_slots s
          WHERE s.cleanup_id = ${event.id} AND s.capacity IS NOT NULL
            AND (SELECT count(*) FROM cleanup_slot_claims c WHERE c.slot_id = s.id) > s.capacity
        `
  if (Number(overCap?.n ?? 0) > 0) throw new Error("verification failed: a slot is over capacity")
  if (event.capacity !== null && (await goingCount(tx, event.id)) > event.capacity) {
    throw new Error("verification failed: event over capacity")
  }
}

async function joinDemoUsers(
  tx: TransactionSql,
  opts: { eventRef: string; count: number; hashFor: (seatId: string) => string },
): Promise<number> {
  const event = await loadJoinableEvent(tx, opts.eventRef)
  const candidates = await eligibleDemoUsers(tx, event)
  const room = await remainingRoom(tx, event)

  const joiners = shuffle([...candidates]).slice(0, Math.min(opts.count, candidates.length, room))
  const now = new Date()
  const windowStart = rsvpWindowStart(event.created_at, now)
  const memberRows: MemberRow[] = joiners
    .map((u) => ({
      cleanup_id: event.id,
      user_id: u.id,
      role: "member",
      joined_at: joinTimestamp(windowStart, now),
    }))
    .sort((a, b) => a.joined_at.getTime() - b.joined_at.getTime())
  await tx`INSERT INTO cleanup_members ${tx(memberRows)}`
  const seats = await mintDemoSignupSeats(tx, {
    cleanupId: event.id,
    members: memberRows,
    hashFor: opts.hashFor,
  })
  const claimed = await claimDemoSlots(tx, event.id, memberRows)

  const handles = joiners.map((u) => `@${u.handle}`).join(", ")
  console.log(
    `joining ${memberRows.length} demo users (${seats} registrations)` +
      `${claimed > 0 ? ` (${claimed} slot claims)` : ""}:`,
  )
  console.log(`  ${handles}`)

  await verifyJoin(tx, event)
  return memberRows.length
}

async function main(): Promise<void> {
  const commit = process.argv.includes("--yes")
  const eventRef = argValue("--event")
  const count = Number(argValue("--count") ?? DEFAULT_JOIN_COUNT)
  const prngSeed = Number(argValue("--seed") ?? DEMO_PRNG_SEED)
  seedDemoRandom(prngSeed)

  if (!eventRef)
    throw new Error("--event <reference-code|uuid> is required (e.g. --event 1695-000006)")
  if (!Number.isInteger(count) || count < 1 || count > MAX_JOIN_COUNT)
    throw new Error(`--count must be 1..${MAX_JOIN_COUNT}`)
  const databaseUrl = requireDatabaseUrl()
  const hashFor = demoTicketTokenHasher()

  console.log(`target database: ${new URL(databaseUrl).host}`)
  console.log(
    commit
      ? "mode: COMMIT"
      : "mode: rehearsal (runs everything, then ROLLBACK; pass --yes to commit)",
  )

  const ROLLBACK = Symbol("rollback")
  await runDbCli(
    async (_db, sql) => {
      const outcome = await sql
        .begin(async (tx) => {
          const joined = await joinDemoUsers(tx, { eventRef, count, hashFor })
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- a unique sentinel, matched by identity in the catch below, that makes sql.begin roll the rehearsal back
          if (!commit) throw ROLLBACK
          return joined
        })
        .catch((e: unknown) => {
          if (e === ROLLBACK) return "rolledback" as const
          throw e
        })

      if (outcome === "rolledback") {
        console.log("rehearsal complete, rolled back. Re-run with --yes to commit.")
      } else {
        console.log(`committed: ${outcome} joins.`)
      }
    },
    { databaseUrl },
  )
}

runIfMain(import.meta.url, "demo-join-event", main)
