import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { getTableConfig } from "drizzle-orm/pg-core"
import { PgDialect } from "drizzle-orm/pg-core"
import { organizationInvites } from "../../src/db/schema/organization_invites.js"

const INDEX_NAME = "organization_invites_inviter_pending_idx"
const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "drizzle",
  "0182_organization_invites_invited_by_idx.sql",
)

describe("organization_invites inviter index for account erasure", () => {
  it("ships an idempotent partial index on invited_by over pending rows", () => {
    const ddl = readFileSync(MIGRATION, "utf8").replace(/--.*$/gm, "").replace(/\s+/g, " ")

    expect(ddl).toContain(
      `CREATE INDEX IF NOT EXISTS ${INDEX_NAME} ON organization_invites (invited_by) WHERE status = 'pending';`,
    )
    expect(ddl).not.toMatch(/CONCURRENTLY/i)
  })

  it("is mirrored in the Drizzle schema with the same column and predicate", () => {
    const index = getTableConfig(organizationInvites).indexes.find(
      (i) => i.config.name === INDEX_NAME,
    )

    expect(index).toBeDefined()
    expect(index!.config.columns.map((c) => ("name" in c ? c.name : null))).toEqual(["invited_by"])
    const where = new PgDialect().sqlToQuery(index!.config.where!).sql
    expect(where).toBe(`"organization_invites"."status" = 'pending'`)
  })
})
