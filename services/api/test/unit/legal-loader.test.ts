import { describe, expect, it } from "vitest"
import type { LegalDocumentVersion } from "@civfix/contract/legal"
import { loadLegalDocuments } from "../../src/services/legal-loader.js"
import {
  InMemoryLegalDocumentsRepository,
  type StoredLegalDocument,
} from "../helpers/legal-documents-repository.memory.js"
import {
  NEW_BLOCKS,
  NEW_TERMS,
  PRE_EPIC,
  RETIRED,
  keyOf,
  storedRow,
} from "../helpers/legal-fixtures.js"

const LOADED_AT = new Date("2026-10-26T09:00:00.000Z")
const P_AND_N: readonly LegalDocumentVersion[] = [...PRE_EPIC, NEW_TERMS]
const N_TEXTS = { [keyOf(NEW_TERMS)]: NEW_BLOCKS }

function repoWith(rows: readonly StoredLegalDocument[] = []): InMemoryLegalDocumentsRepository {
  return new InMemoryLegalDocumentsRepository(rows, () => LOADED_AT)
}

function seeded(): StoredLegalDocument[] {
  return [...PRE_EPIC.map((entry) => storedRow(entry)), RETIRED]
}

function rowFor(repo: InMemoryLegalDocumentsRepository, key: string): StoredLegalDocument {
  const row = repo.rows.find((r) => `${r.type}@${r.version}` === key)
  if (row === undefined) throw new Error(`no row ${key}`)
  return row
}

describe("loadLegalDocuments", () => {
  it("T1: inserts every contract version into an empty table, with N's record and blocks", async () => {
    const repo = repoWith()
    await loadLegalDocuments(repo, P_AND_N, N_TEXTS)

    expect(repo.rows).toHaveLength(11)
    for (const entry of PRE_EPIC) {
      const row = rowFor(repo, keyOf(entry))
      expect(row).toMatchObject({
        type: entry.type,
        version: entry.version,
        sha256: entry.sha256,
        url: entry.url,
        title: null,
        summary: null,
        material: null,
        blocks: null,
      })
      expect(row.effectiveAt.getTime()).toBe(Date.parse(entry.effectiveAt))
    }
    const n = rowFor(repo, keyOf(NEW_TERMS))
    expect(n.title).toBe("Terms of Service")
    expect(n.summary).toBe("No change in wording")
    expect(n.material).toBe(false)
    expect(n.blocks).toEqual(NEW_BLOCKS)
  })

  it("T2: fills only the missing version on a seeded table and changes no existing row", async () => {
    const repo = repoWith(seeded())
    const before = structuredClone(repo.rows)

    await loadLegalDocuments(repo, P_AND_N, N_TEXTS)

    expect(repo.inserted).toHaveLength(1)
    expect(repo.inserted[0]?.map(keyOf)).toEqual([keyOf(NEW_TERMS)])
    expect(repo.rows).toHaveLength(12)
    expect(repo.rows.slice(0, 11)).toEqual(before)
    expect(rowFor(repo, keyOf(RETIRED))).toEqual(RETIRED)
  })

  it("T3: a second load inserts nothing and leaves the table as the first left it", async () => {
    const repo = repoWith()
    await loadLegalDocuments(repo, P_AND_N, N_TEXTS)
    const afterFirst = structuredClone(repo.rows)

    const inserted = await loadLegalDocuments(repo, P_AND_N, N_TEXTS)

    expect(inserted).toEqual([])
    expect(repo.inserted).toHaveLength(1)
    expect(repo.rows).toEqual(afterFirst)
  })

  const TERMS_0921 = "terms@2026-09-21"
  const drifts: [field: string, key: string, change: (row: StoredLegalDocument) => void][] = [
    ["sha256", TERMS_0921, (row) => (row.sha256 = "f".repeat(64))],
    ["effectiveAt", TERMS_0921, (row) => (row.effectiveAt = new Date("2026-09-22T00:00:00Z"))],
    ["url", TERMS_0921, (row) => (row.url = "https://example.org")],
    ["title", keyOf(NEW_TERMS), (row) => (row.title = "Terms of Use")],
    ["summary", keyOf(NEW_TERMS), (row) => (row.summary = "Reworded")],
    ["material", keyOf(NEW_TERMS), (row) => (row.material = true)],
    ["blocks", keyOf(NEW_TERMS), (row) => (row.blocks = [{ kind: "paragraph", text: "Bye." }])],
  ]

  it.each(drifts)(
    "T4: refuses a stored %s that differs from the contract",
    async (field, key, change) => {
      const rows = [...PRE_EPIC.map((entry) => storedRow(entry)), storedRow(NEW_TERMS, NEW_BLOCKS)]
      const target = rows.find((row) => `${row.type}@${row.version}` === key)
      if (target === undefined) throw new Error(`no row ${key}`)
      change(target)
      const repo = repoWith(rows)

      const [type, version] = key.split("@") as [string, string]
      await expectRefusal(loadLegalDocuments(repo, P_AND_N, N_TEXTS), type, version, field)
    },
  )

  it("T5: a drifted row stops the load before N is inserted", async () => {
    const repo = repoWith(PRE_EPIC.map((entry) => storedRow(entry)))
    rowFor(repo, TERMS_0921).url = "https://example.org"

    await expectRefusal(loadLegalDocuments(repo, P_AND_N, N_TEXTS), "terms", "2026-09-21", "url")

    expect(repo.inserted).toEqual([])
    expect(repo.rows.some((row) => row.version === NEW_TERMS.version)).toBe(false)
  })

  it("T6: refuses a new-style version whose sha256 is not the hash of its record", async () => {
    const repo = repoWith()
    const forged: LegalDocumentVersion = { ...NEW_TERMS, sha256: "0".repeat(64) }

    await expectRefusal(
      loadLegalDocuments(repo, [...PRE_EPIC, forged], N_TEXTS),
      "terms",
      "2026-10-26",
      "sha256",
    )

    expect(repo.rows).toEqual([])
  })

  it("T7: refuses a new-style version that has no blocks", async () => {
    const repo = repoWith()

    await expectRefusal(loadLegalDocuments(repo, P_AND_N, {}), "terms", "2026-10-26", "blocks")

    expect(repo.rows).toEqual([])
  })
})

async function expectRefusal(
  load: Promise<unknown>,
  type: string,
  version: string,
  field: string,
): Promise<void> {
  const err = await load.then(
    () => null,
    (reason: unknown) => reason,
  )
  expect(err).toBeInstanceOf(Error)
  const message = (err as Error).message
  expect(message).toContain(type)
  expect(message).toContain(version)
  expect(message).toContain(field)
}
