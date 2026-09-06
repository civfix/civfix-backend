import type { Sql } from "../../db/client.js"

export const REGISTRATION_RETENTION_BATCH = 500

export const REGISTRATION_RETENTION_MAX_PAGES = 20

export const ANSWER_RETENTION_DAYS = 30

export const CHECKIN_COARSEN_DAYS = 30

export const ATTENDEE_NAME_RETENTION_DAYS = 30

export const HOST_NOTE_RETENTION_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000

export interface RegistrationRetentionResult {
  scrubbedAnswers: number
  coarsenedCheckins: number
  clearedAttendeeNames: number
  clearedHostNotes: number
}

export interface RegistrationRetentionLogger {
  warn(obj: unknown, msg?: string): void
}

async function drain(
  lane: string,
  page: (batchSize: number) => Promise<number>,
  logger?: RegistrationRetentionLogger,
): Promise<number> {
  let total = 0
  for (let i = 0; i < REGISTRATION_RETENTION_MAX_PAGES; i++) {
    let done: number
    try {
      done = await page(REGISTRATION_RETENTION_BATCH)
    } catch (err) {
      logger?.warn({ err, lane, total }, "registration retention: lane failed (suppressed)")
      return total
    }
    total += done
    if (done < REGISTRATION_RETENTION_BATCH) return total
  }
  logger?.warn(
    { lane, total },
    "registration retention: hit the page ceiling with rows still pending; the next run continues",
  )
  return total
}

export async function runRegistrationRetentionLanes(
  sql: Sql,
  now: Date,
  logger?: RegistrationRetentionLogger,
): Promise<RegistrationRetentionResult> {
  const answerCutoff = new Date(now.getTime() - ANSWER_RETENTION_DAYS * DAY_MS)
  const checkinCutoff = new Date(now.getTime() - CHECKIN_COARSEN_DAYS * DAY_MS)
  const nameCutoff = new Date(now.getTime() - ATTENDEE_NAME_RETENTION_DAYS * DAY_MS)
  const noteCutoff = new Date(now.getTime() - HOST_NOTE_RETENTION_DAYS * DAY_MS)

  const scrubbedAnswers = await drain(
    "event answers",
    async (batchSize) => {
      const rows = await sql<{ id: string }[]>`
        UPDATE cleanup_answers a
           SET value_text = NULL, value_json = NULL, scrubbed_at = ${now}
         WHERE a.id IN (
           SELECT a2.id
             FROM cleanup_answers a2
             JOIN cleanups c ON c.id = a2.cleanup_id
            WHERE a2.scrubbed_at IS NULL
              AND COALESCE(c.ends_at, c.scheduled_at) < ${answerCutoff}
            LIMIT ${batchSize}
         )
        RETURNING a.id
      `
      return rows.length
    },
    logger,
  )

  const coarsenedCheckins = await drain(
    "check-in coarsening",
    async (batchSize) => {
      const rows = await sql<{ id: string }[]>`
        UPDATE cleanup_registration_seats s
           SET checked_in_at = date_trunc('day', s.checked_in_at),
               checkin_coarsened_at = ${now}
         WHERE s.id IN (
           SELECT s2.id
             FROM cleanup_registration_seats s2
             JOIN cleanups c ON c.id = s2.cleanup_id
            WHERE s2.checked_in_at IS NOT NULL
              AND s2.checkin_coarsened_at IS NULL
              AND COALESCE(c.ends_at, c.scheduled_at) < ${checkinCutoff}
            LIMIT ${batchSize}
         )
        RETURNING s.id
      `
      return rows.length
    },
    logger,
  )

  const clearedAttendeeNames = await drain(
    "attendee names",
    async (batchSize) => {
      const rows = await sql<{ id: string }[]>`
        UPDATE cleanup_registration_seats s
           SET attendee_name = NULL
         WHERE s.id IN (
           SELECT s2.id
             FROM cleanup_registration_seats s2
             JOIN cleanups c ON c.id = s2.cleanup_id
            WHERE s2.attendee_name IS NOT NULL
              AND COALESCE(c.ends_at, c.scheduled_at) < ${nameCutoff}
            LIMIT ${batchSize}
         )
        RETURNING s.id
      `
      return rows.length
    },
    logger,
  )

  const clearedHostNotes = await drain(
    "host notes",
    async (batchSize) => {
      const rows = await sql<{ id: string }[]>`
        UPDATE cleanup_registrations r
           SET host_note = NULL
         WHERE r.id IN (
           SELECT r2.id
             FROM cleanup_registrations r2
             JOIN cleanups c ON c.id = r2.cleanup_id
            WHERE r2.host_note IS NOT NULL
              AND COALESCE(c.ends_at, c.scheduled_at) < ${noteCutoff}
            LIMIT ${batchSize}
         )
        RETURNING r.id
      `
      return rows.length
    },
    logger,
  )

  return { scrubbedAnswers, coarsenedCheckins, clearedAttendeeNames, clearedHostNotes }
}
