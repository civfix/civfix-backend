import type { Queryable, SqlFragment } from "../../db/client.js"
import {
  ROUTE_CLAIM_STALE_SECONDS,
  ROUTE_DEADLINE_INFLIGHT_SECONDS,
} from "./outbound-send-policy.js"

export function latestOutboundAttempt(sql: Queryable, threadRef: SqlFragment): SqlFragment {
  return sql`
    SELECT m.id, m.created_at
    FROM mail_messages m
    WHERE m.thread_id = ${threadRef} AND m.direction = 'out'
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  `
}

export function attemptEventExists(
  sql: Queryable,
  threadRef: SqlFragment,
  type: "sent" | "failed",
  extra: SqlFragment,
): SqlFragment {
  return sql`
    EXISTS (
      SELECT 1 FROM mail_events e
      WHERE e.thread_id = ${threadRef}
        AND e.message_id = latest.id::text
        AND e.type = ${type}
        ${extra}
    )
  `
}

// The outbound row is inserted before transmission starts, so a young attempt with no outcome yet is
// still on the wire; it is in flight until the same stale window after which sendFailedExpr calls it
// crashed.
export function sendInFlightExpr(sql: Queryable, threadRef: SqlFragment): SqlFragment {
  return sql`
    COALESCE(
      (
        SELECT
          NOT ${attemptEventExists(sql, threadRef, "sent", sql``)}
          AND (
            ${attemptEventExists(
              sql,
              threadRef,
              "failed",
              sql`AND e.meta->>'reason' = 'deadline'
                  AND e.created_at > now() - make_interval(secs => ${ROUTE_DEADLINE_INFLIGHT_SECONDS})`,
            )}
            OR (
              NOT ${attemptEventExists(sql, threadRef, "failed", sql``)}
              AND latest.created_at > now() - make_interval(secs => ${ROUTE_CLAIM_STALE_SECONDS})
            )
          )
        FROM (${latestOutboundAttempt(sql, threadRef)}) latest
      ),
      false
    )
  `
}

export function sendFailedExpr(sql: Queryable, threadRef: SqlFragment): SqlFragment {
  return sql`
    NOT EXISTS (
      SELECT 1 FROM mail_events e WHERE e.thread_id = ${threadRef} AND e.type = 'sent'
    )
    AND COALESCE(
      (
        SELECT
          CASE
            WHEN ${attemptEventExists(
              sql,
              threadRef,
              "failed",
              sql`AND COALESCE(e.meta->>'reason', '') <> 'deadline'`,
            )} THEN true
            WHEN ${attemptEventExists(
              sql,
              threadRef,
              "failed",
              sql`AND e.meta->>'reason' = 'deadline'
                  AND e.created_at > now() - make_interval(secs => ${ROUTE_DEADLINE_INFLIGHT_SECONDS})`,
            )} THEN false
            WHEN ${attemptEventExists(sql, threadRef, "failed", sql``)} THEN true
            ELSE latest.created_at < now() - make_interval(secs => ${ROUTE_CLAIM_STALE_SECONDS})
          END
        FROM (${latestOutboundAttempt(sql, threadRef)}) latest
      ),
      false
    )
  `
}
