/**
 * drizzle/0200_notifications_unread_page_index_guard.sql: a guard only. The index it watches is built out
 * of band (docs/out-of-band-indexes.md), so after the whole migration suite has applied the index must
 * still not exist, and applying the file again must only raise its WARNING.
 */

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import postgres from "postgres"
import { withPg, type PgHarness } from "../helpers/pg.js"

const pg = await withPg()

const MIGRATION = fileURLToPath(
  new URL("../../drizzle/0200_notifications_unread_page_index_guard.sql", import.meta.url),
)

function statementsOf(text: string): string[] {
  const code = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim()
  // The DO body is dollar-quoted, so its inner semicolons are not statement ends.
  const out: string[] = []
  let rest = code
  while (rest.length > 0) {
    const doBlock = /^DO \$\$[\s\S]*?\$\$;/.exec(rest)
    const end = doBlock ? doBlock[0].length : rest.indexOf(";") + 1 || rest.length
    out.push(rest.slice(0, end).trim())
    rest = rest.slice(end).trim()
  }
  return out
}

describe.skipIf(!pg)("0200 notifications unread page index guard (integration)", () => {
  let h: PgHarness
  let text: string

  beforeAll(async () => {
    h = pg as PgHarness
    text = await readFile(MIGRATION, "utf8")
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("T45: holds one DO block that warns while the index is missing, and builds nothing", async () => {
    const statements = statementsOf(text)
    expect(statements).toHaveLength(1)
    const only = statements[0]!
    expect(only).toMatch(/^DO \$\$/)
    expect(only).toContain("IF to_regclass('public.notifications_user_unread_page_idx') IS NULL THEN")
    expect(only).toMatch(/RAISE WARNING '/)
    expect(only).not.toMatch(/CREATE\s+INDEX/i)

    const [after] = await h.sql<{ idx: string | null }[]>`
      SELECT to_regclass('public.notifications_user_unread_page_idx')::text AS idx
    `
    expect(after!.idx).toBeNull()

    const notices: { severity: string; message: string }[] = []
    const conn = postgres(h.uri, {
      max: 1,
      onnotice: (n) => notices.push({ severity: n.severity, message: n.message }),
    })
    try {
      await conn.begin((tx) => tx.unsafe(text))
    } finally {
      await conn.end({ timeout: 5 })
    }
    expect(notices).toHaveLength(1)
    expect(notices[0]!.severity).toBe("WARNING")
    expect(notices[0]!.message).toContain("notifications_user_unread_page_idx")

    const [again] = await h.sql<{ idx: string | null }[]>`
      SELECT to_regclass('public.notifications_user_unread_page_idx')::text AS idx
    `
    expect(again!.idx).toBeNull()
  })
})
