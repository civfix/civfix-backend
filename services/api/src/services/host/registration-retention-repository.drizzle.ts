import type { Sql } from "../../db/client.js"
import type { RegistrationRetentionRepository } from "./registration-retention-repository.js"

export function makeDrizzleRegistrationRetentionRepository(
  sql: Sql,
): RegistrationRetentionRepository {
  return {
    async scrubAnswers(cutoff: Date, now: Date, batchSize: number): Promise<number> {
      const rows = await sql<{ id: string }[]>`
        UPDATE cleanup_answers a
           SET value_text = NULL, value_json = NULL, scrubbed_at = ${now}
         WHERE a.id IN (
           SELECT a2.id
             FROM cleanup_answers a2
             JOIN cleanups c ON c.id = a2.cleanup_id
            WHERE a2.scrubbed_at IS NULL
              AND COALESCE(c.ends_at, c.scheduled_at) < ${cutoff}
            LIMIT ${batchSize}
         )
        RETURNING a.id
      `
      return rows.length
    },

    async coarsenCheckins(cutoff: Date, now: Date, batchSize: number): Promise<number> {
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
              AND COALESCE(c.ends_at, c.scheduled_at) < ${cutoff}
            LIMIT ${batchSize}
         )
        RETURNING s.id
      `
      return rows.length
    },

    async clearAttendeeNames(cutoff: Date, batchSize: number): Promise<number> {
      const rows = await sql<{ id: string }[]>`
        UPDATE cleanup_registration_seats s
           SET attendee_name = NULL
         WHERE s.id IN (
           SELECT s2.id
             FROM cleanup_registration_seats s2
             JOIN cleanups c ON c.id = s2.cleanup_id
            WHERE s2.attendee_name IS NOT NULL
              AND COALESCE(c.ends_at, c.scheduled_at) < ${cutoff}
            LIMIT ${batchSize}
         )
        RETURNING s.id
      `
      return rows.length
    },

    async clearHostNotes(cutoff: Date, batchSize: number): Promise<number> {
      const rows = await sql<{ id: string }[]>`
        UPDATE cleanup_registrations r
           SET host_note = NULL
         WHERE r.id IN (
           SELECT r2.id
             FROM cleanup_registrations r2
             JOIN cleanups c ON c.id = r2.cleanup_id
            WHERE r2.host_note IS NOT NULL
              AND COALESCE(c.ends_at, c.scheduled_at) < ${cutoff}
            LIMIT ${batchSize}
         )
        RETURNING r.id
      `
      return rows.length
    },
  }
}
