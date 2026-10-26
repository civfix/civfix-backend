import type { LegalBlock, LegalDocumentVersion } from "@civfix/contract/legal"
import type { LegalDocumentsRepository } from "./legal-documents-repository.js"

export function loadLegalDocuments(
  _repo: LegalDocumentsRepository,
  _versions: readonly LegalDocumentVersion[],
  _texts: Readonly<Record<string, readonly LegalBlock[]>>,
): Promise<string[]> {
  throw new Error("not implemented")
}
