/**
 * Signup-seat backfill (DECISIONS §44). A sign-up on an event with NO ticket types now writes a free
 * `cleanup_registrations` row plus one `cleanup_registration_seats` row, so the host roster, the
 * check-in scanner, the counters and the attendee's own ticket all work on slot-based events. Rows
 * that predate that change have a `cleanup_members` row and nothing else — this CLI mints the missing
 * registration + seat for them.
 *
 * It is a Node one-shot and NOT a SQL migration because `ticket_token_hash` is
 * sha256(base32(hmac(TICKET_TOKEN_SECRET, seat_id))) — the HMAC is not computable in Postgres without
 * putting the ticket secret in the database.
 *
 *   DATABASE_URL=postgres://... pnpm db:backfill:signup-seats              # rehearse (rollback), report
 *   DATABASE_URL=postgres://... pnpm db:backfill:signup-seats -- --yes     # commit
 *   DATABASE_URL=postgres://... pnpm db:backfill:signup-seats -- --yes --batch 200
 *
 * Scope: every `cleanup_members` row of an event that is not cancelled and has not ended
 * (`ends_at > now()`), that has zero ticket types, where the member holds no active registration —
 * organizers included, because the live `claimSlot` path mints a seat for an organizer who claims
 * their own shift and 0169 gave every existing member a slot claim. Safe to re-run: the insert
 * carries the same `ON CONFLICT (cleanup_id, user_id) WHERE status = 'registered'` arbiter the
 * runtime path uses, and the candidate query already excludes anyone who has a registration.
 */

import { randomUUID } from "node:crypto"
import type postgres from "postgres"
import type { Sql } from "./client.js"
import { runDbCli, runIfMain } from "./cli.js"
import { loadEnv } from "../env.js"
import { makeTicketTokenSigner } from "../services/host/ticket-token.js"

type SqlFragment = postgres.Fragment

export const SIGNUP_SEAT_BACKFILL_BATCH = 500

class RehearsalRollback extends Error {
  constructor(readonly written: number) {
    super("rehearsal rollback")
  }
}

interface CandidateRow {
  cleanup_id: string
  user_id: string
  joined_at: Date
}

interface RegistrationInsertRow {
  id: string
  cleanup_id: string
  ticket_type_id: string | null
  user_id: string
  guest_id: string | null
  party_size: number
  status: string
  source: string
  registered_at: Date
}

interface SeatInsertRow {
  id: string
  cleanup_id: string
  registration_id: string
  seat_index: number
  attendee_name: string | null
  ticket_token_hash: string
  status: string
  created_at: Date
}

export interface SignupSeatBackfillResult {
  scanned: number
  created: number
  batches: number
}

export async function backfillSignupSeats(
  sql: Sql,
  opts: {
    hashFor: (seatId: string) => string
    commit: boolean
    batchSize?: number
    log?: (message: string) => void
  },
): Promise<SignupSeatBackfillResult> {
  const batchSize = opts.batchSize ?? SIGNUP_SEAT_BACKFILL_BATCH
  const log = opts.log ?? ((message: string) => console.log(`backfill-signup-seats: ${message}`))
  let scanned = 0
  let created = 0
  let batches = 0
  let cursor: { cleanupId: string; userId: string } | null = null

  for (;;) {
    const cursorFilter: SqlFragment =
      cursor === null
        ? sql``
        : sql`AND (m.cleanup_id, m.user_id) > (${cursor.cleanupId}, ${cursor.userId})`
    const page = await sql<CandidateRow[]>`
      SELECT m.cleanup_id, m.user_id, m.joined_at
      FROM cleanup_members m
      JOIN cleanups c ON c.id = m.cleanup_id
      WHERE c.status <> 'cancelled'
        AND c.ends_at > now()
        AND NOT EXISTS (
          SELECT 1 FROM cleanup_ticket_types t WHERE t.cleanup_id = m.cleanup_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM cleanup_registrations r
           WHERE r.cleanup_id = m.cleanup_id
             AND r.user_id = m.user_id
             AND r.status = 'registered'
        )
        ${cursorFilter}
      ORDER BY m.cleanup_id, m.user_id
      LIMIT ${batchSize}
    `
    if (page.length === 0) break

    const registrations: RegistrationInsertRow[] = page.map((row) => ({
      id: randomUUID(),
      cleanup_id: row.cleanup_id,
      ticket_type_id: null,
      user_id: row.user_id,
      guest_id: null,
      party_size: 1,
      status: "registered",
      source: "self",
      registered_at: row.joined_at,
    }))
    const seatOf = new Map<string, SeatInsertRow>(
      registrations.map((registration) => {
        const seatId = randomUUID()
        const seat: SeatInsertRow = {
          id: seatId,
          cleanup_id: registration.cleanup_id,
          registration_id: registration.id,
          seat_index: 0,
          attendee_name: null,
          ticket_token_hash: opts.hashFor(seatId),
          status: "active",
          created_at: registration.registered_at,
        }
        return [registration.id, seat]
      }),
    )

    const written = await sql
      .begin(async (tx) => {
        const inserted: { id: string }[] = await tx`
          INSERT INTO cleanup_registrations ${tx(
            registrations,
            "id",
            "cleanup_id",
            "ticket_type_id",
            "user_id",
            "guest_id",
            "party_size",
            "status",
            "source",
            "registered_at",
          )}
          ON CONFLICT (cleanup_id, user_id) WHERE status = 'registered' AND user_id IS NOT NULL
          DO NOTHING
          RETURNING id
        `
        const seats = inserted
          .map((row) => seatOf.get(row.id))
          .filter((seat): seat is SeatInsertRow => seat !== undefined)
        if (seats.length > 0) {
          await tx`
            INSERT INTO cleanup_registration_seats ${tx(
              seats,
              "id",
              "cleanup_id",
              "registration_id",
              "seat_index",
              "attendee_name",
              "ticket_token_hash",
              "status",
              "created_at",
            )}
          `
        }
        if (!opts.commit) throw new RehearsalRollback(seats.length)
        return seats.length
      })
      .catch((err: unknown) => {
        if (err instanceof RehearsalRollback) return err.written
        throw err
      })

    scanned += page.length
    created += written
    batches += 1
    const last = page[page.length - 1]
    if (last === undefined) break
    cursor = { cleanupId: last.cleanup_id, userId: last.user_id }
    log(`batch ${batches}: ${page.length} candidates, ${written} seats; running scanned=${scanned}`)
    if (!opts.commit) break
  }

  return { scanned, created, batches }
}

export async function main(): Promise<void> {
  const commit = process.argv.includes("--yes")
  const batchIndex = process.argv.indexOf("--batch")
  const batchSize =
    batchIndex >= 0 ? Number(process.argv[batchIndex + 1] ?? SIGNUP_SEAT_BACKFILL_BATCH) : undefined
  const signer = makeTicketTokenSigner(loadEnv().TICKET_TOKEN_SECRET.trim())

  console.log(
    commit
      ? "backfill-signup-seats: mode COMMIT"
      : "backfill-signup-seats: mode rehearsal (one batch, written then ROLLED BACK; pass --yes to commit)",
  )
  await runDbCli(async (_db, sql) => {
    const result = await backfillSignupSeats(sql, {
      hashFor: (seatId) => signer.hashFor(seatId),
      commit,
      ...(batchSize !== undefined ? { batchSize } : {}),
    })
    console.log(
      `backfill-signup-seats: done — scanned=${result.scanned} seats=${result.created} batches=${result.batches}` +
        (commit ? "" : " (rolled back; re-run with --yes to commit)"),
    )
  })
}

runIfMain(import.meta.url, "backfill-signup-seats", main)
