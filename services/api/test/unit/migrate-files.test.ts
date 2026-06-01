/**
 * Unit test for the migration file ordering (src/db/migrate-files.ts). Pure, no DB / no real fs:
 * orderMigrationFiles takes a directory listing (as the migrate runner gets from readdir) and must
 * return only the .sql files in deterministic lexical order, regardless of input order or platform
 * readdir ordering.
 */

import { describe, expect, it } from "vitest"
import { orderMigrationFiles } from "../../src/db/migrate-files.js"

describe("orderMigrationFiles", () => {
  it("sorts .sql files lexically ascending regardless of input order", () => {
    // Simulate an out-of-order readdir() result.
    const entries = ["0002_chat_partitioning.sql", "0000_extensions.sql", "0001_core.sql"]
    expect(orderMigrationFiles(entries)).toEqual([
      "0000_extensions.sql",
      "0001_core.sql",
      "0002_chat_partitioning.sql",
    ])
  })

  it("ignores non-.sql entries (READMEs, journals, dotfiles, directories)", () => {
    const entries = [
      "0001_core.sql",
      "README.md",
      ".gitkeep",
      "meta", // a directory name, no extension
      "0000_extensions.sql",
      "notes.txt",
    ]
    expect(orderMigrationFiles(entries)).toEqual(["0000_extensions.sql", "0001_core.sql"])
  })

  it("matches .SQL case-insensitively but preserves the original filename", () => {
    const entries = ["0001_Core.SQL", "0000_extensions.sql"]
    expect(orderMigrationFiles(entries)).toEqual(["0000_extensions.sql", "0001_Core.SQL"])
  })

  it("returns a new array and does not mutate the input", () => {
    const entries = ["0001_core.sql", "0000_extensions.sql"]
    const copy = [...entries]
    const out = orderMigrationFiles(entries)
    expect(entries).toEqual(copy) // input untouched
    expect(out).not.toBe(entries) // new array
  })

  it("handles an empty listing", () => {
    expect(orderMigrationFiles([])).toEqual([])
  })

  it("orders zero-padded numeric prefixes correctly past 9 (lexical == intended)", () => {
    const entries = ["0010_j.sql", "0009_i.sql", "0002_b.sql", "0000_a.sql"]
    expect(orderMigrationFiles(entries)).toEqual([
      "0000_a.sql",
      "0002_b.sql",
      "0009_i.sql",
      "0010_j.sql",
    ])
  })
})
