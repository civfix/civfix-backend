import { createHash } from "node:crypto"
import type {
  LegalAcceptAction,
  LegalDocumentMetaDTO,
  LegalDocumentType,
  LegalVersionOutdatedDetails,
} from "@civfix/contract"
import type { LegalDocumentVersion } from "@civfix/contract/legal"
import type { StoredLegalDocument } from "./legal-documents-repository.memory.js"
import { NEW_BLOCKS } from "./legal-fixtures.js"

// The fixtures of issue #239's test cases: V, C, Meta, Cur, Item and outdated.

export function sha(x: string): string {
  return createHash("sha256").update(x).digest("hex")
}

const TYPE_ORDER: readonly LegalDocumentType[] = ["terms", "privacy", "cookies", "subprocessors"]

const TITLE: Record<LegalDocumentType, string> = {
  terms: "Terms",
  privacy: "Privacy",
  cookies: "Cookies",
  subprocessors: "Subprocessors",
}

/** V, newest last per type, with `material` null on the pre-§66 versions. */
const V_ENTRIES: readonly (readonly [LegalDocumentType, string, boolean | null])[] = [
  ["terms", "2026-09-16", null],
  ["terms", "2026-09-21", null],
  ["terms", "2026-10-26", false],
  ["terms", "2026-11-02", true],
  ["terms", "2026-11-09", false],
  ["privacy", "2026-09-16", null],
  ["privacy", "2026-09-21", null],
  ["privacy", "2026-10-26", false],
  ["privacy", "2026-12-15", true],
  ["cookies", "2026-09-16", null],
  ["cookies", "2026-10-26", false],
  ["subprocessors", "2026-09-16", null],
  ["subprocessors", "2026-10-26", false],
]

/** V as the contract's metadata, the version list the shared consent check reads. */
export const V: readonly LegalDocumentVersion[] = V_ENTRIES.map(([type, version, material]) => ({
  type,
  version,
  effectiveAt: `${version}T00:00:00.000Z`,
  url: `https://civfix.org/legal/${type}`,
  sha256: sha(`${type}@${version}`),
  ...(material === null
    ? {}
    : { title: `${TITLE[type]} v${version}`, summary: "No change in wording", material }),
}))

/** V as `legal_documents` rows. */
export function vRows(): StoredLegalDocument[] {
  return V.map((entry) => ({
    type: entry.type,
    version: entry.version,
    sha256: entry.sha256,
    effectiveAt: new Date(entry.effectiveAt),
    url: entry.url,
    title: entry.title ?? null,
    summary: entry.summary ?? null,
    material: entry.material ?? null,
    blocks: entry.title === undefined ? null : structuredClone([...NEW_BLOCKS]),
    createdAt: new Date("2026-09-30T08:00:00.000Z"),
  }))
}

/** C, the clock. */
export const C = new Date("2026-12-01T12:00:00.000Z")

export const DAY_MS = 86_400_000

function entryOf(key: string): LegalDocumentVersion {
  const entry = V.find((e) => `${e.type}@${e.version}` === key)
  if (entry === undefined) throw new Error(`no V entry ${key}`)
  return entry
}

export function meta(key: string): LegalDocumentMetaDTO {
  const entry = entryOf(key)
  return {
    type: entry.type,
    version: entry.version,
    effectiveAt: entry.effectiveAt,
    url: entry.url,
    title: entry.title ?? null,
    summary: entry.summary ?? null,
    material: entry.material ?? null,
    sha256: entry.sha256,
  }
}

/** Cur: the current version of each type at C. */
export const CUR: Record<LegalDocumentType, string> = {
  terms: "terms@2026-11-09",
  privacy: "privacy@2026-10-26",
  cookies: "cookies@2026-10-26",
  subprocessors: "subprocessors@2026-10-26",
}

export function item(
  key: string,
  action: LegalAcceptAction,
): { type: LegalDocumentType; version: string; sha256: string; action: LegalAcceptAction } {
  const entry = entryOf(key)
  return { type: entry.type, version: entry.version, sha256: entry.sha256, action }
}

/** outdated(types)'s details, with the current version of each type at `current` (Cur by default). */
export function outdatedDetails(
  types: readonly LegalDocumentType[],
  current: Partial<Record<LegalDocumentType, string>> = CUR,
): LegalVersionOutdatedDetails {
  return {
    reason: "legal_version_outdated",
    current: TYPE_ORDER.filter((type) => types.includes(type)).map((type) => {
      const entry = entryOf(current[type] ?? CUR[type])
      return { type, version: entry.version, sha256: entry.sha256 }
    }),
  }
}
