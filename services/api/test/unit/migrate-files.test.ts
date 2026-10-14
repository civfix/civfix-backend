/**
 * Unit test for the migration file ordering (src/db/migrate-files.ts). Pure, no DB / no real fs:
 * orderMigrationFiles takes a directory listing (as the migrate runner gets from readdir) and must
 * return only the .sql files in deterministic lexical order, regardless of input order or platform
 * readdir ordering.
 */

import { readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { orderMigrationFiles } from "../../src/db/migrate-files.js"

/** Absolute path to services/api/drizzle, resolved from this test file (cwd-independent). */
const DRIZZLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle")

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
    expect(entries).toEqual(copy)
    expect(out).not.toBe(entries)
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

  // Guards the deploy contract WITHOUT Docker: the migration runner applies exactly these files, in this
  // order. If a new migration lands (or one is renamed/removed) this fails until the canonical list (and
  // the Docker-gated schema bookkeeping assertion) is updated to match. The same list the runner reads.
  it("the REAL services/api/drizzle directory holds exactly 0000..0009 (DM + privacy) in order", () => {
    const ordered = orderMigrationFiles(readdirSync(DRIZZLE_DIR))
    expect(ordered).toContain("0009_dm_and_privacy.sql")
    expect(ordered.slice(0, 10)).toEqual([
      "0000_extensions.sql",
      "0001_core.sql",
      "0002_chat_partitioning.sql",
      "0003_users_email.sql",
      "0004_cleanup_address.sql",
      "0005_report_claim_code.sql",
      "0006_user_profile.sql",
      "0007_admin_phase2.sql",
      "0008_chat_read_state.sql",
      "0009_dm_and_privacy.sql",
    ])
  })

  // Two branches that each take "highest + 1" land the same number. Both files still apply (the ledger is
  // keyed by filename), but their relative order then depends on the name after the number, not on intent.
  it("gives every migration in the REAL services/api/drizzle directory its own number", () => {
    const numbers = orderMigrationFiles(readdirSync(DRIZZLE_DIR)).map((name) =>
      name.slice(0, name.indexOf("_")),
    )
    const duplicates = numbers.filter((n, i) => numbers.indexOf(n) !== i)
    expect(duplicates).toEqual([])
  })
})
