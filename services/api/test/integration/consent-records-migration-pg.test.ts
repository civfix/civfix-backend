/**
 * drizzle/0231_consent_records_actions.sql against a real database: the template every file clones has
 * every migration applied (T41), and running the file's SQL again changes nothing (T42).
 */

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"

const pg = await withPg()

const MIGRATION = fileURLToPath(
  new URL("../../drizzle/0231_consent_records_actions.sql", import.meta.url),
)

const SURFACES = [
  "web_donate",
  "web_org_settings",
  "web_register",
  "mobile_register",
  "onboarding",
  "signup",
  "prompt",
  "notice",
  "event_registration",
]

describe.skipIf(!pg)("0231 consent records actions migration (integration)", () => {
  let h: PgHarness
  let text: string
  let userId: string

  beforeAll(async () => {
    h = pg as PgHarness
    text = await readFile(MIGRATION, "utf8")
    const [user] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES ('Consenting', ${testHandle()}) RETURNING id
    `
    userId = user!.id
  })

  afterAll(async () => {
    await h.teardown()
  })

  const apply = () => h.sql.begin((tx) => tx.unsafe(text))

  async function shape() {
    const columns = await h.sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'consent_records'
      ORDER BY ordinal_position
    `
    const constraints = await h.sql`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE conrelid = to_regclass('consent_records')
      ORDER BY conname
    `
    const indexes = await h.sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'consent_records'
      ORDER BY indexname
    `
    const [comment] = await h.sql<{ comment: string | null }[]>`
      SELECT obj_description('consent_records'::regclass) AS comment
    `
    return {
      columns: [...columns],
      constraints: [...constraints],
      indexes: [...indexes],
      comment: comment!.comment,
    }
  }

  const TERMS = "52fe3908a8d7aa4427239a7555a2d7b2346d7a2b9730dfb539ecd157f6195772"

  function insert(fields: { action?: string; surface?: string }) {
    const surface = fields.surface ?? "prompt"
    if (fields.action === undefined) {
      return h.sql<{ action: string; surface: string }[]>`
        INSERT INTO consent_records
          (subject_kind, user_id, document_type, document_version, document_sha256, surface)
        VALUES ('user', ${userId}, 'terms', '2026-09-21', ${TERMS}, ${surface})
        RETURNING action, surface
      `
    }
    return h.sql<{ action: string; surface: string }[]>`
      INSERT INTO consent_records
        (subject_kind, user_id, document_type, document_version, document_sha256, action, surface)
      VALUES ('user', ${userId}, 'terms', '2026-09-21', ${TERMS}, ${fields.action}, ${surface})
      RETURNING action, surface
    `
  }

  it("T41: adds the action column, the four surfaces, the two indexes and the corrected comment", async () => {
    const { columns, indexes, comment } = await shape()

    expect(columns.find((c) => c.column_name === "action")).toEqual({
      column_name: "action",
      data_type: "text",
      is_nullable: "NO",
      column_default: "'accepted'::text",
    })
    expect(await insert({})).toEqual([{ action: "accepted", surface: "prompt" }])
    await expect(insert({ action: "other" })).rejects.toMatchObject({ code: "23514" })
    for (const surface of SURFACES) {
      expect(await insert({ action: "acknowledged", surface }), surface).toEqual([
        { action: "acknowledged", surface },
      ])
    }
    await expect(insert({ surface: "bogus" })).rejects.toMatchObject({ code: "23514" })

    const defs = indexes.map((i) => i.indexdef)
    expect(
      defs.filter((d) =>
        d.endsWith(
          "USING btree (user_id, document_type, accepted_at DESC) WHERE (subject_kind = 'user'::text)",
        ),
      ),
    ).toHaveLength(1)
    expect(
      defs.filter((d) =>
        d.endsWith(
          "USING btree (document_type, document_version) WHERE (subject_kind = 'user'::text)",
        ),
      ),
    ).toHaveLength(1)
    expect(comment).not.toMatch(/NULLs user_id/i)
    expect(comment).toContain("kept with the anonymized account")
  })

  it("T42: running the file again changes nothing", async () => {
    const before = await shape()
    await apply()

    expect(await shape()).toEqual(before)
  })
})
