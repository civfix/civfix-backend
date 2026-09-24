import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const HERE = dirname(fileURLToPath(import.meta.url))
const DRIZZLE_DIR = join(HERE, "..", "..", "drizzle")
const WORKER_REPO = join(HERE, "..", "..", "src", "services", "media-worker-repo.ts")

function orphanBindingColumns(): string[] {
  const src = readFileSync(WORKER_REPO, "utf8")
  const body = src.slice(src.indexOf("function orphanPredicate("))
  const matches = [...body.matchAll(/media_assets\.(\w+) IS NULL/g)].map((m) => m[1] ?? "")
  return [...new Set(matches)]
}

const HISTORICAL_BINDINGS = ["discussion_message_id"]

const GRANDFATHERED_UNREPOINTED = ["0044_drop_report_discussion.sql"]

interface Drop {
  file: string
  column: string
  at: number
  sql: string
}

function bindingDrops(): Drop[] {
  const bindings = [...orphanBindingColumns(), ...HISTORICAL_BINDINGS]
  const drops: Drop[] = []
  for (const file of readdirSync(DRIZZLE_DIR).filter((n) => n.toLowerCase().endsWith(".sql"))) {
    const sql = readFileSync(join(DRIZZLE_DIR, file), "utf8")
    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+media_assets\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(\w+)/gi,
    )) {
      const column = (m[1] ?? "").toLowerCase()
      if (!bindings.includes(column)) continue
      drops.push({ file, column, at: m.index ?? 0, sql })
    }
  }
  return drops
}

describe("F147: dropping a media binding column must re-point its rows first", () => {
  it("derives the binding set from the orphan sweep's own predicate", () => {
    expect(orphanBindingColumns().sort()).toEqual(["chat_message_id", "post_id", "report_id"])
  })

  it("every binding-column drop re-points the bound rows earlier in the same migration", () => {
    for (const drop of bindingDrops()) {
      if (GRANDFATHERED_UNREPOINTED.includes(drop.file)) continue
      const before = drop.sql.slice(0, drop.at)
      const repoint = new RegExp(
        `UPDATE\\s+media_assets\\s+SET\\s+\\w+\\s*=\\s*${drop.column}\\b`,
        "i",
      )
      expect(
        repoint.test(before),
        `${drop.file} drops media_assets.${drop.column} without re-pointing the bound rows first: ` +
          "every row bound only by it becomes orphan-sweep bait (row DELETEd, R2 object deleted)",
      ).toBe(true)
    }
  })

  it("pins the historical unrepointed drop so the grandfathered set cannot grow", () => {
    const unrepointed = bindingDrops()
      .filter((d) => {
        const before = d.sql.slice(0, d.at)
        return !new RegExp(
          `UPDATE\\s+media_assets\\s+SET\\s+\\w+\\s*=\\s*${d.column}\\b`,
          "i",
        ).test(before)
      })
      .map((d) => d.file)
    expect([...new Set(unrepointed)].sort()).toEqual(GRANDFATHERED_UNREPOINTED)
  })
})
