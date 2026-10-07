import type { Sql } from "../../db/client.js"
import { makeDrizzleRegistrationRetentionRepository } from "./registration-retention-repository.drizzle.js"
import { MS_PER_DAY } from "../../lib/time.js"

export const REGISTRATION_RETENTION_BATCH = 500

export const REGISTRATION_RETENTION_MAX_PAGES = 20

export const ANSWER_RETENTION_DAYS = 30

export const CHECKIN_COARSEN_DAYS = 30

const ATTENDEE_NAME_RETENTION_DAYS = 30

export const HOST_NOTE_RETENTION_DAYS = 90

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
  const repo = makeDrizzleRegistrationRetentionRepository(sql)
  const answerCutoff = new Date(now.getTime() - ANSWER_RETENTION_DAYS * MS_PER_DAY)
  const checkinCutoff = new Date(now.getTime() - CHECKIN_COARSEN_DAYS * MS_PER_DAY)
  const nameCutoff = new Date(now.getTime() - ATTENDEE_NAME_RETENTION_DAYS * MS_PER_DAY)
  const noteCutoff = new Date(now.getTime() - HOST_NOTE_RETENTION_DAYS * MS_PER_DAY)

  const scrubbedAnswers = await drain(
    "event answers",
    (batchSize) => repo.scrubAnswers(answerCutoff, now, batchSize),
    logger,
  )

  const coarsenedCheckins = await drain(
    "check-in coarsening",
    (batchSize) => repo.coarsenCheckins(checkinCutoff, now, batchSize),
    logger,
  )

  const clearedAttendeeNames = await drain(
    "attendee names",
    (batchSize) => repo.clearAttendeeNames(nameCutoff, batchSize),
    logger,
  )

  const clearedHostNotes = await drain(
    "host notes",
    (batchSize) => repo.clearHostNotes(noteCutoff, batchSize),
    logger,
  )

  return { scrubbedAnswers, coarsenedCheckins, clearedAttendeeNames, clearedHostNotes }
}
