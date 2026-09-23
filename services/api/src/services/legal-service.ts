import {
  AppError,
  ErrorCode,
  type LegalDocumentType,
  type LegalDocumentVersionDTO,
} from "@civfix/shared"
import { LEGAL_DOCUMENTS, legalDocument } from "@civfix/shared/legal"

export const LEGAL_VERSIONS_CACHE_SECONDS = 300

export function legalDocumentVersions(): LegalDocumentVersionDTO[] {
  return LEGAL_DOCUMENTS.map((document) => ({
    type: document.type,
    version: document.version,
    sha256: document.sha256,
    effectiveAt: document.effectiveAt,
    url: document.url,
  }))
}

export function currentLegalDocument(type: LegalDocumentType): LegalDocumentVersionDTO {
  const document = legalDocument(type)
  return {
    type: document.type,
    version: document.version,
    sha256: document.sha256,
    effectiveAt: document.effectiveAt,
    url: document.url,
  }
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
    throw new AppError(
      ErrorCode.CONFLICT,
      "The terms shown to you have been updated. Reload the page and review them before continuing.",
      { fields: stale },
    )
  }
}

export function consentDocumentsFor(
  claims: readonly ConsentVersionClaim[],
): { documentType: LegalDocumentType; documentVersion: string; documentSha256: string }[] {
  return claims.map((claim) => {
    const document = legalDocument(claim.type)
    return {
      documentType: document.type,
      documentVersion: document.version,
      documentSha256: document.sha256,
    }
  })
}
