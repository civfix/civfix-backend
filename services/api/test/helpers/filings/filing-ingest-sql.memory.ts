import type {
  ApplyCityUpdateInput,
  ApplyCityUpdateResult,
  FilingIngestSql,
} from "../../../src/services/filings/filing-ingest-sql.drizzle.js"
import type { InMemoryAdminReportRepository } from "../admin/admin-report-repository.memory.js"
import type { InMemoryFilingRepository } from "./filing-repository.memory.js"

export class InMemoryFilingIngestSql implements FilingIngestSql {
  constructor(
    readonly filings: InMemoryFilingRepository,
    readonly reports: InMemoryAdminReportRepository,
  ) {}

  reportIdByReferenceCode(_code: string): Promise<string | null> {
    return Promise.reject(new Error("not implemented"))
  }

  applyCityUpdate(_input: ApplyCityUpdateInput): Promise<ApplyCityUpdateResult> {
    return Promise.reject(new Error("not implemented"))
  }
}
