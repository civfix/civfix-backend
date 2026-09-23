import { describe, expect, it } from "vitest"
import { csvCell, csvProvenanceRow, csvRow } from "../../src/services/host/export-csv.js"

describe("csv cells in a locale whose list separator splits a value", () => {
  it("neutralizes a formula that would start a new field after ';'", () => {
    expect(csvRow(["a;=1+1"])).toBe('"a;\'=1+1"\n')
    expect(csvRow(["id", "x;=cmd|' /C calc'!A0"])).toBe('"id","x;\'=cmd|\' /C calc\'!A0"\n')
  })

  it("neutralizes a trigger after ',', a tab, a newline or a carriage return", () => {
    expect(csvCell("a,+1")).toBe('"a,\'+1"')
    expect(csvCell("a\t@SUM(A1)")).toBe('"a\t\'@SUM(A1)"')
    expect(csvCell("line1\n=1+1")).toBe('"line1\n\'=1+1"')
    expect(csvCell("line1\r\n-1")).toBe('"line1\r\n\'-1"')
  })

  it("neutralizes a trigger that spaces separate from the separator", () => {
    expect(csvCell("a;  =1")).toBe('"a;  \'=1"')
  })

  it("neutralizes a trigger that is itself a separator, and the trigger after it", () => {
    expect(csvCell("a\t\t=1")).toBe("\"a\t'\t'=1\"")
  })

  it("leaves a separator followed by ordinary text untouched", () => {
    expect(csvCell("Smith, Alex; Oakland")).toBe('"Smith, Alex; Oakland"')
    expect(csvCell("2026-02-05")).toBe('"2026-02-05"')
  })

  it("keeps the leading-character guard inside the quotes", () => {
    expect(csvCell("=1+1")).toBe('"\'=1+1"')
    expect(csvCell("@SUM(A1)")).toBe('"\'@SUM(A1)"')
    expect(csvCell("=a;=b")).toBe("\"'=a;'=b\"")
  })

  it("quotes cells a spreadsheet would otherwise re-split: leading space and full-width equals", () => {
    expect(csvCell(" =1")).toBe('" =1"')
    expect(csvCell("＝1+1")).toBe('"＝1+1"')
  })

  it("never prefixes a number, even a negative one", () => {
    expect(csvCell(-3)).toBe('"-3"')
    expect(csvCell(-0.5)).toBe('"-0.5"')
    expect(csvRow([42, "x"])).toBe('"42","x"\n')
  })

  it("guards provenance lines like any other string cell", () => {
    expect(csvProvenanceRow("note;=1")).toBe('"# note;\'=1"\n')
  })
})
