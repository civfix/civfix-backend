import type { Queryable } from "../../db/client.js"

export type ReopenFilingOutcome = "created" | "skipped_active" | "none"

/** D12's `reasonDetail` for the filing a reopen opens after the city closed the report's request. */
export function reopenReasonDetail(caseId: string | null): string {
  return caseId === null ? "Previous request had no number" : `Previous request ${caseId}`
}

/**
 * D12: a report leaving `resolved` after its city closed the request gets a `needs_human` filing, so an
 * operator files it again (Retry resolves the route). It runs inside the status change's own transaction,
 * so a failed insert rolls the status change back instead of losing the refiling.
 */
export async function insertReopenFilingIn(
  tx: Queryable,
  reportId: string,
): Promise<ReopenFilingOutcome> {
  const [closed] = await tx<
    {
      geoid: string | null
      category: string
      case_id: string | null
      ticket_text: string
      city_closed_at: Date | null
    }[]
  >`
    SELECT geoid, category, case_id, ticket_text, city_closed_at
    FROM report_filings
    WHERE report_id = ${reportId} AND status IN ('submitted', 'linked_existing')
    ORDER BY submitted_at DESC NULLS LAST, id DESC
    LIMIT 1
  `
  if (closed === undefined || closed.city_closed_at === null) return "none"
  // The NOT EXISTS sees an active filing committed before this statement; ON CONFLICT covers one
  // committed while it runs.
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO report_filings (report_id, geoid, category, status, reason, reason_detail, ticket_text)
    SELECT ${reportId}, ${closed.geoid}, ${closed.category}, 'needs_human',
           'reopened_after_city_closed', ${reopenReasonDetail(closed.case_id)}, ${closed.ticket_text}
    WHERE NOT EXISTS (
      SELECT 1 FROM report_filings
      WHERE report_id = ${reportId} AND status IN ('queued', 'running', 'needs_human')
    )
    ON CONFLICT (report_id) WHERE status IN ('queued', 'running', 'needs_human') DO NOTHING
    RETURNING id
  `
  return inserted.length > 0 ? "created" : "skipped_active"
}
