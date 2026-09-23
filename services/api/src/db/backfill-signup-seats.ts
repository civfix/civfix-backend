/**
 * A sign-up on an event with no ticket types writes a free registration plus one seat (DECISIONS §44);
 * members who joined before that have neither, and this CLI mints them.
 *
 * A Node one-shot rather than a SQL migration because `ticket_token_hash` is an HMAC over the ticket
 * secret, which is not computable in Postgres without putting the secret in the database.
 *
 *   DATABASE_URL=postgres://... pnpm db:backfill:signup-seats              # rehearse (rollback), report
 *   DATABASE_URL=postgres://... pnpm db:backfill:signup-seats -- --yes     # commit
 *   DATABASE_URL=postgres://... pnpm db:backfill:signup-seats -- --yes --batch 200
 *
 * Organizers are included, because the live claimSlot path mints a seat for an organizer who claims
 * their own shift and 0169 gave every existing member a slot claim. Safe to re-run: the insert carries
 * the same ON CONFLICT arbiter the runtime path uses.
 */

import { randomUUID } from "node:crypto"
import type postgres from "postgres"
import type { Sql } from "./client.js"
import { EXIT_USAGE, runDbCli, runIfMain } from "./cli.js"
import { loadEnv } from "../env.js"
import { makeTicketTokenSigner } from "../services/host/ticket-token.js"

type SqlFragment = postgres.Fragment

const SIGNUP_SEAT_BACKFILL_BATCH = 500

export const SIGNUP_SEAT_BACKFILL_MAX_BATCH = 5000

const BATCH_FLAG = "--batch"
const DIGITS_ONLY_RE = /^\d+$/

// undefined = flag absent (use the default); null = a value that is not a usable LIMIT.
export function parseSignupSeatBatchArg(argv: readonly string[]): number | undefined | null {
  const at = argv.indexOf(BATCH_FLAG)
  if (at < 0) return undefined
  const raw = argv[at + 1]
  if (raw === undefined || !DIGITS_ONLY_RE.test(raw)) return null
  const size = Number(raw)
  return size >= 1 && size <= SIGNUP_SEAT_BACKFILL_MAX_BATCH ? size : null
}

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

interface SignupSeatBackfillResult {
  scanned: number
  created: number
  batches: number
}

/** One free registration plus its single seat per candidate, mirroring the live sign-up write. */
function signupRowsFor(
  page: readonly CandidateRow[],
  hashFor: (seatId: string) => string,
): { registrations: RegistrationInsertRow[]; seatOf: Map<string, SeatInsertRow> } {
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
        ticket_token_hash: hashFor(seatId),
        status: "active",
        created_at: registration.registered_at,
      }
      return [registration.id, seat]
    }),
  )
  return { registrations, seatOf }
}

async function backfillSignupSeats(
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

    const { registrations, seatOf } = signupRowsFor(page, opts.hashFor)

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

async function main(): Promise<void> {
  const commit = process.argv.includes("--yes")
  const batchSize = parseSignupSeatBatchArg(process.argv)
  if (batchSize === null) {
    console.error(
      `backfill-signup-seats: ${BATCH_FLAG} takes an integer from 1 to ${SIGNUP_SEAT_BACKFILL_MAX_BATCH}`,
    )
    process.exit(EXIT_USAGE)
  }
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
      `backfill-signup-seats: done: scanned=${result.scanned} seats=${result.created} batches=${result.batches}` +
        (commit ? "" : " (rolled back; re-run with --yes to commit)"),
    )
  })
}

runIfMain(import.meta.url, "backfill-signup-seats", main)
