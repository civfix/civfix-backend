import type { Sql } from "../db/client.js"
import type { LegalDocumentsRepository } from "./legal-documents-repository.js"

export function makeLegalDocumentsRepository(_sql: Sql): LegalDocumentsRepository {
  throw new Error("not implemented")
}
