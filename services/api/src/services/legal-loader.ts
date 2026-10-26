import { isDeepStrictEqual } from "node:util"
import type { LegalBlock, LegalDocumentVersion } from "@civfix/contract/legal"
import { legalRecordSha256 } from "@civfix/contract/legal-texts"
import type { LegalDocumentRecord, LegalDocumentsRepository } from "./legal-documents-repository.js"

type ComparedField = Exclude<keyof LegalDocumentRecord, "type" | "version">

const COMPARED_FIELDS: readonly ComparedField[] = [
  "sha256",
  "effectiveAt",
  "url",
  "title",
  "summary",
  "material",
  "blocks",
]

function refusal(entry: LegalDocumentVersion, problem: string): Error {
  return new Error(`Legal document ${entry.type} version ${entry.version}: ${problem}`)
}

/**
 * The row the contract describes. A version written since §66 must have its blocks, and its sha256 must be
 * the hash of its whole record: only this loader and the contract's own check ever compute it (D3).
 */
function recordOf(
  entry: LegalDocumentVersion,
  texts: Readonly<Record<string, readonly LegalBlock[]>>,
): LegalDocumentRecord {
  const blocks = texts[`${entry.type}@${entry.version}`]
  const hasRecord =
    entry.title !== undefined || entry.summary !== undefined || entry.material !== undefined
  if (hasRecord) {
    if (blocks === undefined) {
      throw refusal(entry, `the contract has no blocks for it in @civfix/contract/legal-texts`)
    }
    if (legalRecordSha256(entry, blocks) !== entry.sha256) {
      throw refusal(entry, `its sha256 in the contract is not the hash of its record and blocks`)
    }
  } else if (blocks !== undefined) {
    throw refusal(entry, `the contract has blocks for it but no title, summary and material`)
  }
  return {
    type: entry.type,
    version: entry.version,
    sha256: entry.sha256,
    effectiveAt: new Date(entry.effectiveAt),
    url: entry.url,
    title: entry.title ?? null,
    summary: entry.summary ?? null,
    material: entry.material ?? null,
    blocks: blocks === undefined ? null : structuredClone([...blocks]),
  }
}

function sameValue(field: ComparedField, stored: unknown, wanted: unknown): boolean {
  if (field === "effectiveAt") return (stored as Date).getTime() === (wanted as Date).getTime()
  // jsonb reorders object keys, so blocks compare by value, not by serialization.
  return isDeepStrictEqual(stored, wanted)
}

/**
 * Inserts every contract version `legal_documents` does not have yet and returns their `type@version`
 * keys. Versions are immutable (D9): a stored version that differs from the contract in any field stops
 * the load with an error naming it, and is never updated. Everything is checked before the first insert,
 * so a refused load writes nothing even outside a transaction.
 */
export async function loadLegalDocuments(
  repo: LegalDocumentsRepository,
  versions: readonly LegalDocumentVersion[],
  texts: Readonly<Record<string, readonly LegalBlock[]>>,
): Promise<string[]> {
  const wanted = versions.map((entry) => ({ entry, record: recordOf(entry, texts) }))
  const stored = new Map(
    (await repo.listAll()).map((row) => [`${row.type}@${row.version}`, row] as const),
  )

  const missing: LegalDocumentRecord[] = []
  for (const { entry, record } of wanted) {
    const row = stored.get(`${record.type}@${record.version}`)
    if (row === undefined) {
      missing.push(record)
      continue
    }
    for (const field of COMPARED_FIELDS) {
      if (!sameValue(field, row[field], record[field])) {
        throw refusal(
          entry,
          `the database's ${field} differs from the contract's. Published versions never change: ` +
            `publish a new version in @civfix/contract instead.`,
        )
      }
    }
  }

  if (missing.length > 0) await repo.insert(missing)
  return missing.map((record) => `${record.type}@${record.version}`)
}
