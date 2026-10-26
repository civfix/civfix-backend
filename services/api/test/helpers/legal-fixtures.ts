import { LEGAL_DOCUMENTS, type LegalBlock, type LegalDocumentVersion } from "@civfix/contract/legal"
import { legalRecordSha256 } from "@civfix/contract/legal-texts"
import type { StoredLegalDocument } from "./legal-documents-repository.memory.js"

// The test cases' fixtures (CIV-467): P, R, N and F.

/** P: the pre-§66 versions in the contract, exactly as 0151/0171/0172 seed them. */
export const PRE_EPIC: readonly LegalDocumentVersion[] = LEGAL_DOCUMENTS.filter(
  (entry) => entry.title === undefined,
)

export const SEEDED_AT = new Date("2026-09-30T08:00:00.000Z")

/** R: a retired type's row from 0151, which the contract no longer has. */
export const RETIRED: StoredLegalDocument = {
  type: "donations",
  version: "2026-09-06",
  sha256: "461190ba108e771ff6a3c89cec0b5451bf5d05ff89e33231ff4c5493e0723544",
  effectiveAt: new Date("2026-09-06T00:00:00.000Z"),
  url: "https://civfix.org/legal/donations",
  title: null,
  summary: null,
  material: null,
  blocks: null,
  createdAt: SEEDED_AT,
}

export const NEW_BLOCKS: readonly LegalBlock[] = [{ kind: "paragraph", text: "Hello." }]

function withRecordHash(entry: Omit<LegalDocumentVersion, "sha256">): LegalDocumentVersion {
  return { ...entry, sha256: legalRecordSha256(entry, NEW_BLOCKS) }
}

/** N: a new-style version in effect at the test clock. */
export const NEW_TERMS: LegalDocumentVersion = withRecordHash({
  type: "terms",
  version: "2026-10-26",
  effectiveAt: "2026-10-26T00:00:00.000Z",
  url: "https://civfix.org/legal/terms",
  title: "Terms of Service",
  summary: "No change in wording",
  material: false,
})

/** F: a new-style version not yet in effect at the test clock. */
export const FUTURE_PRIVACY: LegalDocumentVersion = withRecordHash({
  type: "privacy",
  version: "2026-11-01",
  effectiveAt: "2026-11-01T00:00:00.000Z",
  url: "https://civfix.org/legal/privacy",
  title: "Privacy Notice",
  summary: "No change in wording",
  material: false,
})

export const TEST_NOW = new Date("2026-10-26T12:00:00.000Z")

export function keyOf(entry: Pick<LegalDocumentVersion, "type" | "version">): string {
  return `${entry.type}@${entry.version}`
}

/** The row the loader writes for `entry`, as stored at `createdAt`. */
export function storedRow(
  entry: LegalDocumentVersion,
  blocks: readonly LegalBlock[] | null = null,
  createdAt: Date = SEEDED_AT,
): StoredLegalDocument {
  return {
    type: entry.type,
    version: entry.version,
    sha256: entry.sha256,
    effectiveAt: new Date(entry.effectiveAt),
    url: entry.url,
    title: entry.title ?? null,
    summary: entry.summary ?? null,
    material: entry.material ?? null,
    blocks: blocks === null ? null : structuredClone([...blocks]),
    createdAt,
  }
}

/** P + R + N + F, the route tests' default table. */
export function defaultRows(): StoredLegalDocument[] {
  return [
    ...PRE_EPIC.map((entry) => storedRow(entry)),
    RETIRED,
    storedRow(NEW_TERMS, NEW_BLOCKS),
    storedRow(FUTURE_PRIVACY, NEW_BLOCKS),
  ]
}
