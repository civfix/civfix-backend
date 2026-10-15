import {
  AppError,
  ErrorCode,
  type LegalDocumentType,
  type LegalDocumentVersionDTO,
} from "@civfix/shared"
import { LEGAL_DOCUMENTS, legalDocument, type LegalDocumentVersion } from "@civfix/shared/legal"

export const LEGAL_VERSIONS_CACHE_SECONDS = 300

const STALE_CONSENT_MESSAGE =
  "The terms shown to you have been updated. Reload the page and review them before continuing."

function toVersionDTO(document: LegalDocumentVersion): LegalDocumentVersionDTO {
  return {
    type: document.type,
    version: document.version,
    sha256: document.sha256,
    effectiveAt: document.effectiveAt,
    url: document.url,
  }
}

export function legalDocumentVersions(): LegalDocumentVersionDTO[] {
  return LEGAL_DOCUMENTS.map(toVersionDTO)
}

export function currentLegalDocument(type: LegalDocumentType): LegalDocumentVersionDTO {
  return toVersionDTO(legalDocument(type))
}

export interface ConsentVersionClaim {
  type: LegalDocumentType
  version: string
}

export function assertConsentVersionsCurrent(claims: readonly ConsentVersionClaim[]): void {
  const stale: Record<string, string> = {}
  for (const claim of claims) {
    const document = legalDocument(claim.type)
    if (document.version !== claim.version) {
      stale[claim.type] = `expected ${document.version}`
    }
  }
  if (Object.keys(stale).length > 0) {
    throw new AppError(ErrorCode.CONFLICT, STALE_CONSENT_MESSAGE, { fields: stale })
  }
}
