/**
 * F147: 0044 dropped media_assets.discussion_message_id without first re-pointing the rows bound only by
 * it (0036 had flattened report_discussion_messages into chat_messages PRESERVING the message id, so a
 * one-line `UPDATE media_assets SET chat_message_id = discussion_message_id` would have carried them
 * over). Those rows fell out with report_id, chat_message_id and post_id all NULL — which is EXACTLY the
 * orphan predicate the media-worker sweep uses, and the sweep DELETEs the row and then the R2 object.
 * The loss is not recoverable forward; what is enforceable is the rule.
 *
 * This guard ties three things together so the mistake cannot repeat silently:
 *   1. the binding columns are READ OUT OF the orphan sweep's own predicate (findOrphans), so adding a
 *      new binding to the sweep without teaching this rule about it fails here;
 *   2. any migration dropping one of those columns must re-point the bound rows in the SAME file,
 *      BEFORE the DROP;
 *   3. the historical unrepointed drop is pinned by name, so the grandfathered set cannot quietly grow.
 */

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const HERE = dirname(fileURLToPath(import.meta.url))
const DRIZZLE_DIR = join(HERE, "..", "..", "drizzle")
const WORKER_REPO = join(HERE, "..", "..", "src", "services", "media-worker-repo.ts")

/** camelCase -> snake_case, the mirror's naming convention for a column. */
function columnName(prop: string): string {
  return prop.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())
}

/** The media_assets columns whose NULLness makes a row orphan-eligible, read from the sweep itself. */
function orphanBindingColumns(): string[] {
  const src = readFileSync(WORKER_REPO, "utf8")
  const body = src.slice(src.indexOf("async findOrphans("))
  const matches = [...body.matchAll(/isNull\(mediaAssets\.(\w+)\)/g)].map((m) =>
    columnName(m[1] ?? ""),
  )
  return [...new Set(matches)]
}

/** Every historical binding column name a migration may legitimately drop. */
const HISTORICAL_BINDINGS = ["discussion_message_id"]

/** Migrations that dropped a binding column WITHOUT re-pointing its rows. Do not grow this list. */
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
        `${drop.file} drops media_assets.${drop.column} without re-pointing the bound rows first — ` +
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
