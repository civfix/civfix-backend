import type { AdminReportStatus, ReportTimelineItem } from "@civfix/contract"
import type { Queryable, Sql } from "../../db/client.js"
import type { FilingChannel, FilingStatus } from "./filing-types.js"
import type { FilingClassification } from "./filings-worker.js"

/** The filing a city update applies to, read under its row lock inside the update's transaction. */
export interface CityUpdateFiling {
  id: string
  reportId: string
  channel: FilingChannel | null
  status: FilingStatus
  caseId: string | null
  jurisdictionName: string | null
}

/** What one classification does (D11, D12): at most one guarded write, or a flag on the row. */
export type CityUpdateEffect =
  | { kind: "none" }
  | { kind: "flag" }
  | { kind: "case_id"; caseId: string; note: string }
  | {
      kind: "report_status"
      from: readonly AdminReportStatus[]
      to: AdminReportStatus
      note: string
      timelineKind: ReportTimelineItem["kind"]
      cityClosed: boolean
    }
  | { kind: "needs_info"; reasonDetail: string }

export interface ApplyCityUpdateInput {
  messageId: string
  /** Null for a payload that failed validation: the row is claimed and flagged, and nothing is stored. */
  classification: FilingClassification | null
  plan(filing: CityUpdateFiling): CityUpdateEffect
}

export type ApplyCityUpdateResult =
  | { claimed: false }
  | { claimed: true; filing: CityUpdateFiling; effect: CityUpdateEffect; applied: boolean }

/**
 * The ingest's queries that reach past the filing tables (D11): the report behind a reference code, and
 * the city update's transaction, which claims the message row and makes its filing, report and timeline
 * writes together so a redelivered or concurrent update applies once.
 */
export interface FilingIngestSql {
  reportIdByReferenceCode(code: string): Promise<string | null>
  /** `claimed: false` when the row is missing, untrusted, flagged or already applied. */
  applyCityUpdate(input: ApplyCityUpdateInput): Promise<ApplyCityUpdateResult>
}

interface CityUpdateFilingRow {
  id: string
  report_id: string
  channel: FilingChannel | null
  status: FilingStatus
  case_id: string | null
  jurisdiction_name: string | null
}

/** The effect's guarded write; false when its guard no longer holds, so the row is flagged instead. */
async function applyEffectIn(
  tx: Queryable,
  filing: CityUpdateFiling,
  effect: Exclude<CityUpdateEffect, { kind: "none" } | { kind: "flag" }>,
): Promise<boolean> {
  switch (effect.kind) {
    case "case_id": {
      const set = await tx`
        UPDATE report_filings SET case_id = ${effect.caseId}, updated_at = now()
        WHERE id = ${filing.id} AND case_id IS NULL
        RETURNING id
      `
      if (set.length === 0) return false
      await tx`
        INSERT INTO report_timeline (report_id, status, note, kind, actor_id)
        SELECT r.id, r.status, ${effect.note}, 'reply', NULL FROM reports r WHERE r.id = ${filing.reportId}
      `
      return true
    }
    case "report_status": {
      const moved = await tx`
        UPDATE reports
        SET status = ${effect.to}
        WHERE id = ${filing.reportId}
          AND deleted_at IS NULL
          AND status = ANY(${effect.from as string[]}::text[])
        RETURNING id
      `
      if (moved.length === 0) return false
      await tx`
        INSERT INTO report_timeline (report_id, status, note, kind, actor_id)
        VALUES (${filing.reportId}, ${effect.to}, ${effect.note}, ${effect.timelineKind ?? null}, NULL)
      `
      if (effect.cityClosed) {
        await tx`
          UPDATE report_filings SET city_closed_at = now(), updated_at = now() WHERE id = ${filing.id}
        `
      }
      return true
    }
    case "needs_info": {
      // needs_human is an active status, which the report may already hold on another filing.
      const moved = await tx`
        UPDATE report_filings f
        SET status = 'needs_human', reason = 'city_needs_info',
            reason_detail = ${effect.reasonDetail}, updated_at = now()
        WHERE f.id = ${filing.id}
          AND f.status IN ('submitted', 'linked_existing')
          AND NOT EXISTS (
            SELECT 1 FROM report_filings a
            WHERE a.report_id = f.report_id AND a.status IN ('queued', 'running', 'needs_human')
          )
        RETURNING f.id
      `
      return moved.length > 0
    }
  }
}

export function makeDrizzleFilingIngestSql(sql: Sql): FilingIngestSql {
  return {
    async reportIdByReferenceCode(code) {
      const [row] = await sql<{ id: string }[]>`
        SELECT id FROM reports WHERE reference_code = ${code} LIMIT 1
      `
      return row?.id ?? null
    },

    async applyCityUpdate(input) {
      const c = input.classification
      return sql.begin(async (tx): Promise<ApplyCityUpdateResult> => {
        const [claimed] = await tx<{ filing_id: string }[]>`
          UPDATE filing_messages
          SET applied_at = now(),
              classification = ${c === null ? null : tx.json(c)},
              summary = ${c?.summary ?? null}
          WHERE id = ${input.messageId} AND applied_at IS NULL AND trusted AND NOT flagged
          RETURNING filing_id
        `
        if (claimed === undefined) return { claimed: false }
        const [row] = await tx<CityUpdateFilingRow[]>`
          SELECT f.id, f.report_id, f.channel, f.status, f.case_id, j.name AS jurisdiction_name
          FROM report_filings f
          LEFT JOIN jurisdictions j ON j.geoid = f.geoid
          WHERE f.id = ${claimed.filing_id}
          FOR UPDATE OF f
        `
        if (row === undefined) throw new Error("filing_messages row names no filing")
        const filing: CityUpdateFiling = {
          id: row.id,
          reportId: row.report_id,
          channel: row.channel,
          status: row.status,
          caseId: row.case_id,
          jurisdictionName: row.jurisdiction_name,
        }
        const effect = input.plan(filing)
        const applied =
          effect.kind !== "none" && effect.kind !== "flag"
            ? await applyEffectIn(tx, filing, effect)
            : false
        if (effect.kind === "flag" || (effect.kind !== "none" && !applied)) {
          await tx`UPDATE filing_messages SET flagged = true WHERE id = ${input.messageId}`
        }
        return { claimed: true, filing, effect, applied }
      })
    },
  }
}
