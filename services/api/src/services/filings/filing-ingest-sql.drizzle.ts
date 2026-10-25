import type { AdminReportStatus, ReportTimelineItem } from "@civfix/contract"
import type { Sql } from "../../db/client.js"
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

export function makeDrizzleFilingIngestSql(_sql: Sql): FilingIngestSql {
  throw new Error("not implemented")
}
