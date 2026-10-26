import type { Queryable, Sql } from "../db/client.js"
import type { LegalAcceptanceRepository, NewConsentRecord } from "./legal-acceptance-repository.js"

export function insertConsentRecords(
  _sql: Queryable,
  _userId: string,
  _records: readonly NewConsentRecord[],
  _at: Date,
): Promise<void> {
  throw new Error("not implemented")
}

export function makeLegalAcceptanceRepository(_sql: Sql): LegalAcceptanceRepository {
  throw new Error("not implemented")
}
