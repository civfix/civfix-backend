import { describe, expect, it } from "vitest"
import { csvCell, csvProvenanceRow, csvRow } from "../../src/services/host/export-csv.js"

describe("csv cells in a semicolon-separator locale", () => {
  it("quotes a cell whose second field would start a formula after ';'", () => {
    expect(csvRow(["a;=1+1"])).toBe('"a;=1+1"\n')
    expect(csvRow(["id", "x;=cmd|' /C calc'!A0"])).toBe('"id","x;=cmd|\' /C calc\'!A0"\n')
  })

  it("keeps the leading-character guard inside the quotes", () => {
    expect(csvCell("=1+1")).toBe('"\'=1+1"')
    expect(csvCell("@SUM(A1)")).toBe('"\'@SUM(A1)"')
  })

  it("quotes cells a spreadsheet would otherwise re-split: leading space and full-width equals", () => {
    expect(csvCell(" =1")).toBe('" =1"')
    expect(csvCell("＝1+1")).toBe('"＝1+1"')
  })

  it("quotes numbers and provenance lines too, so no cell is ever bare", () => {
    expect(csvRow([42, "x"])).toBe('"42","x"\n')
    expect(csvProvenanceRow("note;=1")).toBe('"# note;=1"\n')
  })
})
