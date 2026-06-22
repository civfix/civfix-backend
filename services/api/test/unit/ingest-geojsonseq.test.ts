import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ingestGeoJsonSeqFile } from "../../src/db/ingest-jurisdictions-core.js"

/**
 * Unit test for the STREAMING GeoJSONSeq loader (the fix for the PAD-US federal layer, which is >512 MB and
 * blows Node's max string length when read whole). It must read newline-delimited features one at a time,
 * tolerate the optional RFC 8142 RS (0x1e) record prefix and blank lines, apply the load-time geoid prefix,
 * and skip non-polygon features — without ever materializing the file as a single string. No DB: a
 * capture-only fake `sql` records each upsert's bound values so we can assert the parsed/normalized rows.
 */

const validPolygon = {
  type: "Polygon",
  coordinates: [[[-118, 34], [-117, 34], [-117, 35], [-118, 35], [-118, 34]]],
}
const feature = (props: Record<string, unknown>, geometry: unknown = validPolygon): string =>
  JSON.stringify({ type: "Feature", properties: props, geometry })

/** Fake Sql: begin() runs the txn body with a tagged-template `tx` that records each call's bound values. */
function fakeSql(): { sql: Parameters<typeof ingestGeoJsonSeqFile>[0]; upserts: unknown[][] } {
  const upserts: unknown[][] = []
  const tx = (_s: TemplateStringsArray, ...vals: unknown[]): Promise<unknown[]> => {
    upserts.push(vals)
    return Promise.resolve([])
  }
  const sql = { begin: async (fn: (tx: unknown) => Promise<void>): Promise<void> => fn(tx) }
  return { sql: sql as unknown as Parameters<typeof ingestGeoJsonSeqFile>[0], upserts }
}

describe("ingestGeoJsonSeqFile (streaming GeoJSONSeq loader)", () => {
  it("streams NDJSON features, tolerates RS bytes + blank lines, prefixes geoids, and skips non-polygons", async () => {
    const dir = mkdtempSync(join(tmpdir(), "geojsonseq-"))
    const file = join(dir, "federal.geojsonl")
    const RS = String.fromCharCode(0x1e)
    const body = [
      feature({ OBJECTID: "111", name: "Alpha NF" }),
      "", // blank line: ignored, NOT counted as a feature
      RS + feature({ OBJECTID: "222", name: "Beta NF" }), // RFC 8142 RS prefix tolerated
      feature({ OBJECTID: "333", name: "NoGeom" }, null), // non-polygon: counted but skipped
    ].join("\n")
    writeFileSync(file, body + "\n")

    const { sql, upserts } = fakeSql()
    try {
      const res = await ingestGeoJsonSeqFile(sql, file, "federal", "PADUS-")
      expect(res).toEqual({ features: 3, upserted: 2, skipped: 1 })
      // geoid is the first bound value of upsertJurisdiction's INSERT (VALUES (${row.geoid}, ...)).
      expect(upserts.map((vals) => vals[0])).toEqual(["PADUS-111", "PADUS-222"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
