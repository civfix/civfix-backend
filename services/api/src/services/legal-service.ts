import {
  AppError,
  ErrorCode,
  type GetLegalVersionsResponse,
  type LegalDocumentDTO,
  type LegalDocumentType,
  type LegalDocumentVersionDTO,
} from "@civfix/contract"
import { legalDocument, type LegalDocumentVersion } from "@civfix/contract/legal"
import type {
  LegalDocumentRecord,
  LegalDocumentsRepository,
  LegalVersionRecord,
} from "./legal-documents-repository.js"

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

// The versions DTO predates §66 and keeps `title`, `summary` and `material` optional, so a pre-§66 row
// leaves them out instead of sending null.
function storedVersionDTO(record: LegalVersionRecord): LegalDocumentVersionDTO {
  return {
    type: record.type,
    version: record.version,
    sha256: record.sha256,
    effectiveAt: record.effectiveAt.toISOString(),
    url: record.url,
    ...(record.title !== null ? { title: record.title } : {}),
    ...(record.summary !== null ? { summary: record.summary } : {}),
    ...(record.material !== null ? { material: record.material } : {}),
  }
}

function documentDTO(record: LegalDocumentRecord): LegalDocumentDTO {
  return {
    type: record.type,
    version: record.version,
    effectiveAt: record.effectiveAt.toISOString(),
    url: record.url,
    title: record.title,
    summary: record.summary,
    material: record.material,
    sha256: record.sha256,
    blocks: record.blocks,
  }
}

export interface LegalServiceDeps {
  repo: LegalDocumentsRepository
  now: () => Date
}

export interface LegalService {
  currentDocuments(): Promise<LegalDocumentDTO[]>
  document(type: LegalDocumentType, version: string): Promise<LegalDocumentDTO>
  currentVersions(): Promise<GetLegalVersionsResponse>
  allVersions(): Promise<GetLegalVersionsResponse>
}

/** Serves legal documents from `legal_documents`, never from the contract constant (DECISIONS §66). */
export function makeLegalService({ repo, now }: LegalServiceDeps): LegalService {
  return {
    async currentDocuments() {
      return (await repo.current(now())).map(documentDTO)
    },

    async document(type, version) {
      const record = await repo.find(type, version)
      if (record === null) throw AppError.notFound("Legal document not found")
      return documentDTO(record)
    },

    async currentVersions() {
      const at = now()
      const documents = (await repo.current(at)).map(storedVersionDTO)
      return { documents, generatedAt: at.toISOString() }
    },

    async allVersions() {
      const documents = (await repo.listVersions()).map(storedVersionDTO)
      return { documents, generatedAt: now().toISOString() }
    },
  }
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

export interface EventConsentClaim {
  termsVersion: string
  disclosureVersion: string
}

export function eventConsentDocuments(
  _claim: EventConsentClaim,
  _now: Date,
  _versions: readonly LegalDocumentVersion[] = [],
): { type: LegalDocumentType; version: string; sha256: string }[] {
  throw new Error("not implemented")
}
