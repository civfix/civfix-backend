import type postgres from "postgres"
import type { TransactionSql } from "../db/client.js"
import { DEFAULT_EVENT_TIME_ZONE } from "./host/event-fields.js"
import type { EventCreditChange, EventCreditWrite } from "./volunteer-hours-repository.js"

// Lock order is the 0065 rule shared by every volunteer_hours writer: the event lock, then the
// user locks in sorted order, before any row is read or written.
export async function lockEventCredits(
  tx: TransactionSql,
  cleanupId: string,
  userIds: readonly string[],
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('volunteer_event:' || ${cleanupId}))`
  await lockUserCredits(tx, userIds)
}

// A writer with no event (a manual credit) takes only the user locks; a writer touching an event row
// must call lockEventCredits instead, so the event lock is never taken after a user lock.
export async function lockUserCredits(
  tx: TransactionSql,
  userIds: readonly string[],
): Promise<void> {
  const lockIds = [...new Set(userIds)].sort()
  if (lockIds.length === 0) return
  await tx`
    SELECT pg_advisory_xact_lock(hashtext('volunteer_user:' || u))
    FROM unnest(${lockIds}::uuid[]) AS t(u)
    ORDER BY u
  `
}

// The daily cap counts every live credit dated to the day: event rows by their event's local date,
// manual rows by their service date.
async function creditedHoursOnDay(
  tx: TransactionSql,
  userIds: readonly string[],
  day: postgres.Fragment,
  excludeCleanupId: string | null,
): Promise<Map<string, number>> {
  const rows = await tx<{ user_id: string; hours: number }[]>`
    WITH day AS (${day}),
    held AS (
      SELECT vh.user_id, vh.hours
      FROM volunteer_hours vh
      JOIN cleanups c ON c.id = vh.cleanup_id
      WHERE vh.user_id = ANY(${userIds}::uuid[])
        AND vh.source = 'event'
        AND vh.voided_at IS NULL
        AND vh.cleanup_id IS DISTINCT FROM ${excludeCleanupId}::uuid
        AND (c.scheduled_at AT TIME ZONE COALESCE(c.timezone, ${DEFAULT_EVENT_TIME_ZONE}))::date
          = (SELECT d FROM day)
      UNION ALL
      SELECT vh.user_id, vh.hours
      FROM volunteer_hours vh
      WHERE vh.user_id = ANY(${userIds}::uuid[])
        AND vh.source = 'manual'
        AND vh.voided_at IS NULL
        AND vh.service_date = (SELECT d FROM day)
    )
    SELECT user_id, COALESCE(SUM(hours), 0)::float8 AS hours
    FROM held
    GROUP BY user_id
  `
  return new Map(rows.map((r) => [r.user_id, r.hours]))
}

export async function sameDayEventHours(
  tx: TransactionSql,
  cleanupId: string,
  userIds: readonly string[],
): Promise<Map<string, number>> {
  return creditedHoursOnDay(
    tx,
    userIds,
    tx`
      SELECT (scheduled_at AT TIME ZONE COALESCE(timezone, ${DEFAULT_EVENT_TIME_ZONE}))::date AS d
      FROM cleanups WHERE id = ${cleanupId}
    `,
    cleanupId,
  )
}

export async function hoursHeldOnServiceDate(
  tx: TransactionSql,
  userId: string,
  serviceDate: string,
): Promise<Map<string, number>> {
  return creditedHoursOnDay(tx, [userId], tx`SELECT ${serviceDate}::date AS d`, null)
}

// The prev CTE reads each row before the upsert rewrites it, so the caller must already hold
// lockEventCredits for this event and these users; otherwise a concurrent writer's change is lost
// from the journal and the user_jurisdiction_hours delta.
export async function writeEventCredits(
  tx: TransactionSql,
  write: EventCreditWrite,
): Promise<EventCreditChange[]> {
  const userIds = write.entries.map((e) => e.userId)
  const hoursByRow = write.entries.map((e) => e.hours)
  const journal = await tx<{ user_id: string; previous_hours: number | null; new_hours: number }[]>`
    WITH prev AS (
      -- A voided row already left user_jurisdiction_hours when it was voided, so it counts as
      -- holding 0 hours in no jurisdiction: the revival's rollup delta is its full hours. It
      -- still exists, so the journal records previous_hours = 0, keeping NULL (0053) for a
      -- genuine first credit.
      SELECT
        user_id,
        CASE WHEN voided_at IS NULL THEN hours ELSE 0 END AS old_hours,
        CASE WHEN voided_at IS NULL THEN jurisdiction_geoid END AS old_geoid
      FROM volunteer_hours
      WHERE cleanup_id = ${write.cleanupId}
        AND source = 'event'
        AND user_id = ANY(${userIds}::uuid[])
    ),
    upsert AS (
      INSERT INTO volunteer_hours (
        user_id, hours, source, cleanup_id, jurisdiction_geoid, logged_by_user_id,
        note, credited_by_operator_id
      )
      SELECT
        t.u, t.h, 'event', ${write.cleanupId}, ${write.geoid}::text, ${write.loggedByUserId},
        ${write.note}::text, ${write.creditedByOperatorId}::uuid
      FROM unnest(${userIds}::uuid[], ${hoursByRow}::float8[]) AS t(u, h)
      ON CONFLICT (cleanup_id, user_id) WHERE source = 'event'
      DO UPDATE SET
        hours = EXCLUDED.hours,
        jurisdiction_geoid = EXCLUDED.jurisdiction_geoid,
        logged_by_user_id = EXCLUDED.logged_by_user_id,
        -- A write that changes or revives the row takes over its attribution whole: a host's
        -- correction of an operator credit must not keep showing the operator's reason, and a
        -- revived row is live again, so the previous void's operator and reason no longer describe
        -- it (audit_log and volunteer_hours_audit keep that history).
        note = EXCLUDED.note,
        credited_by_operator_id = EXCLUDED.credited_by_operator_id,
        voided_by_operator_id = NULL,
        void_reason = NULL,
        created_at = CASE
          WHEN volunteer_hours.voided_at IS NULL THEN volunteer_hours.created_at
          ELSE now()
        END,
        voided_at = NULL
      -- An unchanged live row is left alone so a co-host re-saving the whole sheet does not
      -- re-attribute every credit to themselves, journal a no-op, or move the rollup.
      WHERE volunteer_hours.voided_at IS NOT NULL
         OR volunteer_hours.hours <> EXCLUDED.hours
         OR volunteer_hours.jurisdiction_geoid IS DISTINCT FROM EXCLUDED.jurisdiction_geoid
      RETURNING user_id, hours, jurisdiction_geoid
    ),
    journal AS (
      INSERT INTO volunteer_hours_audit
        (cleanup_id, user_id, actor_user_id, previous_hours, new_hours)
      SELECT ${write.cleanupId}, up.user_id, ${write.actorId}, p.old_hours, up.hours
      FROM upsert up
      LEFT JOIN prev p ON p.user_id = up.user_id
      RETURNING user_id, previous_hours, new_hours
    ),
    deltas AS (
      SELECT
        up.user_id,
        up.jurisdiction_geoid AS geoid,
        up.hours - COALESCE(
          CASE WHEN p.old_geoid = up.jurisdiction_geoid THEN p.old_hours END, 0
        ) AS delta
      FROM upsert up
      LEFT JOIN prev p ON p.user_id = up.user_id
      WHERE up.jurisdiction_geoid IS NOT NULL
      UNION ALL
      -- The event moved jurisdictions (or out of coverage) since this attendee was last
      -- credited: take the stale hours back out of the jurisdiction it no longer belongs to.
      -- Disjoint from the branch above (that one is always the CURRENT geoid), so no
      -- (user, geoid) pair is inserted twice.
      SELECT p.user_id, p.old_geoid, -p.old_hours
      FROM upsert up
      JOIN prev p ON p.user_id = up.user_id
      WHERE p.old_geoid IS NOT NULL
        AND p.old_geoid IS DISTINCT FROM up.jurisdiction_geoid
    ),
    rollup AS (
      INSERT INTO user_jurisdiction_hours (user_id, jurisdiction_geoid, total_hours)
      SELECT d.user_id, d.geoid, d.delta FROM deltas d
      ON CONFLICT (user_id, jurisdiction_geoid)
      DO UPDATE SET total_hours = user_jurisdiction_hours.total_hours + EXCLUDED.total_hours
    )
    SELECT
      user_id,
      previous_hours::float8 AS previous_hours,
      new_hours::float8 AS new_hours
    FROM journal
  `
  return journal.map((r) => ({
    userId: r.user_id,
    hours: r.new_hours,
    previousHours: r.previous_hours,
  }))
}
