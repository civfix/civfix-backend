import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ingestGeoJsonSeqFile } from "../../src/db/ingest-jurisdictions-core.js"

const validPolygon = {
  type: "Polygon",
  coordinates: [[[-118, 34], [-117, 34], [-117, 35], [-118, 35], [-118, 34]]],
}
const feature = (props: Record<string, unknown>, geometry: unknown = validPolygon): string =>
  JSON.stringify({ type: "Feature", properties: props, geometry })

function fakeSql(): { sql: Parameters<typeof ingestGeoJsonSeqFile>[0]; batches: unknown[][] } {
  const batches: unknown[][] = []
  const tx = (_s: TemplateStringsArray, ...vals: unknown[]): Promise<unknown[]> => {
    batches.push(vals)
    const geoids = (vals[0] as string[]) ?? []
    return Promise.resolve(geoids.map((geoid) => ({ geoid })))
  }
  const sql = {
    begin: async (fn: (tx: unknown) => Promise<number>): Promise<number> => fn(tx),
  }
  return { sql: sql as unknown as Parameters<typeof ingestGeoJsonSeqFile>[0], batches }
}

describe("ingestGeoJsonSeqFile (streaming GeoJSONSeq loader)", () => {
  it("streams NDJSON features, tolerates RS bytes + blank lines, prefixes geoids, and skips non-polygons", async () => {
    const dir = mkdtempSync(join(tmpdir(), "geojsonseq-"))
    const file = join(dir, "federal.geojsonl")
    const RS = String.fromCharCode(0x1e)
    const body = [
      feature({ OBJECTID: "111", name: "Alpha NF" }),
      "",
      RS + feature({ OBJECTID: "222", name: "Beta NF" }),
      feature({ OBJECTID: "333", name: "NoGeom" }, null),
    ].join("\n")
    writeFileSync(file, body + "\n")

    const { sql, batches } = fakeSql()
    try {
      const res = await ingestGeoJsonSeqFile(sql, file, "federal", "PADUS-")
      expect(res).toEqual({ features: 3, upserted: 2, skipped: 1 })
      expect(batches).toHaveLength(1)
      expect(batches[0]![0]).toEqual(["PADUS-111", "PADUS-222"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("commits in batches so a large file is not one long-held transaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "geojsonseq-"))
    const file = join(dir, "big.geojsonl")
    const total = 2500
    const body = Array.from({ length: total }, (_, i) => feature({ OBJECTID: String(i), name: `NF ${i}` })).join("\n")
    writeFileSync(file, body + "\n")

    const { sql, batches } = fakeSql()
    try {
      const res = await ingestGeoJsonSeqFile(sql, file, "federal", "PADUS-")
      expect(res).toEqual({ features: total, upserted: total, skipped: 0 })
      expect(batches).toHaveLength(3)
      expect(batches[0]![0]).toHaveLength(1000)
      expect(batches[2]![0]).toHaveLength(500)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
