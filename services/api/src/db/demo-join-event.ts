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

import { makeDb, type TransactionSql } from "./client.js"
import { runIfMain } from "./cli.js"
import { DEMO_EMAIL_DOMAIN } from "./seed-demo-domain.js"
import { demoTicketTokenHasher, mintDemoSignupSeats } from "./demo-signup-seats.js"
import { deriveCleanupStatus, eventWindowOf } from "../services/cleanup-rules.js"

let rand = (): number => Math.random()

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function rint(min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1))
}
function chance(p: number): boolean {
  return rand() < p
}
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr
}

/** Biased toward the recent end, because RSVPs cluster after a promo post. */
function joinTimestamp(start: Date, now: Date): Date {
  const span = Math.max(now.getTime() - start.getTime(), 60_000)
  const t = new Date(now.getTime() - Math.pow(rand(), 2) * span)
  t.setUTCMinutes(rint(0, 59), rint(0, 59), 0)
  // The minute/second jitter can overshoot either bound; clamp inside (start, now).
  if (t.getTime() >= now.getTime()) return new Date(now.getTime() - rint(2, 45) * 60_000)
  if (t.getTime() <= start.getTime()) return new Date(start.getTime() + 60_000)
  return t
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

async function loadEvent(tx: TransactionSql, ref: string): Promise<EventRow | null> {
  if (UUID_RE.test(ref)) {
    const rows = await tx<EventRow[]>`
      SELECT id, title, status, scheduled_at, ends_at, created_at, capacity, organizer_user_id
      FROM cleanups WHERE id = ${ref} LIMIT 1
    `
    return rows[0] ?? null
  }
  const code = ref.toUpperCase().startsWith("EVENT-") ? ref.toUpperCase() : `EVENT-${ref}`
  const rows = await tx<EventRow[]>`
    SELECT id, title, status, scheduled_at, ends_at, created_at, capacity, organizer_user_id
    FROM cleanups WHERE reference_code = ${code} LIMIT 1
  `
  return rows[0] ?? null
}

export async function main(): Promise<void> {
  const commit = process.argv.includes("--yes")
  const eventRef = argValue("--event")
  const count = Number(argValue("--count") ?? 15)
  const prngSeed = Number(argValue("--seed") ?? 20260902)
  rand = mulberry32(prngSeed)

  if (!eventRef)
    throw new Error("--event <reference-code|uuid> is required (e.g. --event 1695-000006)")
  if (!Number.isInteger(count) || count < 1 || count > 200)
    throw new Error("--count must be 1..200")
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL is required")
  const hashFor = demoTicketTokenHasher()

  console.log(`target database: ${new URL(databaseUrl).host}`)
  console.log(
    commit
      ? "mode: COMMIT"
      : "mode: rehearsal (runs everything, then ROLLBACK; pass --yes to commit)",
  )

  const handle = makeDb(databaseUrl, { max: 1, statementTimeoutMs: 0, idleInTxTimeoutMs: 0 })
  const ROLLBACK = Symbol("rollback")
  try {
    const outcome = await handle.sql
      .begin(async (tx) => {
        // Same lock the live join takes, so a concurrent cancel/complete cannot race us.
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
        console.log(
          `event: ${event.title} (${derived}, scheduled ${event.scheduled_at.toISOString()})`,
        )

        const candidates = await tx<{ id: string; handle: string; created_at: Date }[]>`
          SELECT u.id, u.handle, u.created_at
          FROM users u
          WHERE u.email LIKE ${"%@" + DEMO_EMAIL_DOMAIN}
            AND u.deleted_at IS NULL
            AND u.id <> ${event.organizer_user_id}
            AND NOT EXISTS (SELECT 1 FROM cleanup_members m WHERE m.cleanup_id = ${event.id} AND m.user_id = u.id)
            AND NOT EXISTS (SELECT 1 FROM cleanup_bans b WHERE b.cleanup_id = ${event.id} AND b.user_id = u.id)
        `
        if (candidates.length === 0) {
          throw new Error(
            `no eligible demo users found (@${DEMO_EMAIL_DOMAIN}); run seed-demo-la first`,
          )
        }

        // The same sum goingCount measures: members plus non-cancelled guests.
        let room = Number.POSITIVE_INFINITY
        if (event.capacity !== null) {
          const [going] = await tx<{ n: number }[]>`
            SELECT (SELECT count(*)::int FROM cleanup_members m WHERE m.cleanup_id = ${event.id})
                 + (SELECT count(*)::int FROM cleanup_guests g
                    WHERE g.cleanup_id = ${event.id} AND g.cancelled_at IS NULL) AS n
          `
          room = Math.max(0, event.capacity - Number(going?.n ?? 0))
          if (room === 0) throw new Error(`event is at capacity (${event.capacity}); nothing to do`)
        }

        const joiners = shuffle([...candidates]).slice(0, Math.min(count, candidates.length, room))
        const now = new Date()
        // RSVPs start after the event existed; cap the spread at the last 5 days so it reads like a
        // burst of signups rather than rows backdated before the event was announced. Clamp the start
        // to at least 12h ago so an event with a bogus/near-future created_at still yields a spread of
        // past join times instead of a one-minute cluster.
        const windowStart = new Date(
          Math.min(
            Math.max(event.created_at.getTime(), now.getTime() - 5 * 24 * 3600_000),
            now.getTime() - 12 * 3600_000,
          ),
        )

        const memberRows = joiners
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
          hashFor,
        })

        const slots = await tx<
          { id: string; title: string; capacity: number | null; claims: number }[]
        >`
          SELECT s.id, s.title, s.capacity,
                 (SELECT count(*)::int FROM cleanup_slot_claims c WHERE c.slot_id = s.id) AS claims
          FROM cleanup_slots s WHERE s.cleanup_id = ${event.id}
          ORDER BY s.sort_order, s.id
        `
        let claimed = 0
        if (slots.length > 0) {
          const open = slots.map((s) => ({ ...s, claims: Number(s.claims) }))
          for (const m of memberRows) {
            if (!chance(0.45)) continue
            const slot = shuffle(
              open.filter((s) => s.capacity === null || s.claims < s.capacity),
            )[0]
            if (!slot) break
            slot.claims++
            claimed++
            await tx`
              INSERT INTO cleanup_slot_claims (cleanup_id, user_id, slot_id, claimed_at)
              VALUES (${event.id}, ${m.user_id}, ${slot.id}, ${new Date(m.joined_at.getTime() + rint(1, 30) * 60_000)})
              ON CONFLICT (cleanup_id, user_id) DO NOTHING
            `
          }
        }

        const handles = joiners.map((u) => `@${u.handle}`).join(", ")
        console.log(
          `joining ${memberRows.length} demo users (${seats} registrations)` +
            `${claimed > 0 ? ` (${claimed} slot claims)` : ""}:`,
        )
        console.log(`  ${handles}`)

        const [overCap] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM cleanup_slots s
          WHERE s.cleanup_id = ${event.id} AND s.capacity IS NOT NULL
            AND (SELECT count(*) FROM cleanup_slot_claims c WHERE c.slot_id = s.id) > s.capacity
        `
        if (Number(overCap?.n ?? 0) > 0)
          throw new Error("verification failed: a slot is over capacity")
        if (event.capacity !== null) {
          const [going] = await tx<{ n: number }[]>`
            SELECT (SELECT count(*)::int FROM cleanup_members m WHERE m.cleanup_id = ${event.id})
                 + (SELECT count(*)::int FROM cleanup_guests g
                    WHERE g.cleanup_id = ${event.id} AND g.cancelled_at IS NULL) AS n
          `
          if (Number(going?.n ?? 0) > event.capacity)
            throw new Error("verification failed: event over capacity")
        }

        if (!commit) throw ROLLBACK
        return memberRows.length
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
  } finally {
    await handle.close()
  }
}

runIfMain(import.meta.url, "demo-join-event", main)
