/**
 * drizzle/0220_runtime_flags.sql as the runner applies it, and the flag repository on real Postgres.
 */
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleRuntimeFlagRepository } from "../../src/services/admin/runtime-flag-repository.drizzle.js"
import type { RuntimeFlagRepository } from "../../src/services/admin/runtime-flag-repository.js"

const pg = await withPg()

const MIGRATION = fileURLToPath(new URL("../../drizzle/0220_runtime_flags.sql", import.meta.url))
const GONE_USER = "99999999-9999-4999-8999-999999999999"

interface StoredRow {
  key: string
  value: unknown
  updated_at: Date
  updated_by: string | null
}

describe.skipIf(!pg)("runtime flags store (integration)", () => {
  let h: PgHarness
  let repo: RuntimeFlagRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleRuntimeFlagRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`DELETE FROM runtime_flags`
    await h.sql`DELETE FROM audit_log WHERE action = 'dev.flag_set'`
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function operator(email: string | null): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, email, role)
      VALUES ('Operator', ${testHandle()}, ${email}, 'operator')
      RETURNING id
    `
    return u!.id
  }

  async function rows(): Promise<StoredRow[]> {
    return [
      ...(await h.sql<StoredRow[]>`
        SELECT key, value, updated_at, updated_by FROM runtime_flags ORDER BY key
      `),
    ]
  }

  async function audits(): Promise<{ actor_id: string; target: string; meta: unknown }[]> {
    return [
      ...(await h.sql<{ actor_id: string; target: string; meta: unknown }[]>`
        SELECT actor_id, target, meta FROM audit_log WHERE action = 'dev.flag_set' ORDER BY created_at
      `),
    ]
  }

  async function shape() {
    const columns = await h.sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'runtime_flags'
      ORDER BY ordinal_position
    `
    const constraints = await h.sql`
      SELECT contype, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE conrelid = to_regclass('runtime_flags')
      ORDER BY contype, def
    `
    return { columns: [...columns], constraints: [...constraints] }
  }

  it("T61: creates runtime_flags exactly, and a re-run is a no-op", async () => {
    const expected = {
      columns: [
        { column_name: "key", data_type: "text", is_nullable: "NO", column_default: null },
        { column_name: "value", data_type: "jsonb", is_nullable: "NO", column_default: null },
        {
          column_name: "updated_at",
          data_type: "timestamp with time zone",
          is_nullable: "NO",
          column_default: "now()",
        },
        { column_name: "updated_by", data_type: "uuid", is_nullable: "YES", column_default: null },
      ],
      constraints: [{ contype: "p", def: "PRIMARY KEY (key)" }],
    }
    expect(await shape()).toEqual(expected)

    const actor = await operator("t61@civfix.org")
    await repo.set({ key: "announcement_text", value: "Hi", actorId: actor })
    const before = await rows()

    const text = await readFile(MIGRATION, "utf8")
    await h.sql.begin((tx) => tx.unsafe(text))

    expect(await shape()).toEqual(expected)
    expect(await rows()).toEqual(before)
  })

  it("T45: an audit insert that fails rolls the change back", async () => {
    const actor = await operator("t45@civfix.org")
    await repo.set({ key: "announcement_text", value: "Hi", actorId: actor })
    const before = await rows()

    await expect(
      repo.set({ key: "announcement_text", value: "Bye", actorId: GONE_USER }),
    ).rejects.toThrow()

    expect(await rows()).toEqual(before)
    expect(before[0]?.value).toBe("Hi")
    expect(await audits()).toHaveLength(1)
  })

  it("stores JSON values, audits each change with the old and new override, and skips a no-op clear", async () => {
    const actor = await operator("ops@civfix.org")
    await repo.set({ key: "announcement_text", value: "Hi", actorId: actor })
    await repo.set({ key: "announcement_text", value: "Bye", actorId: actor })
    await repo.set({ key: "host_messaging_kill_switch", value: true, actorId: actor })
    await repo.set({ key: "announcement_text", value: null, actorId: actor })
    await repo.set({ key: "announcement_text", value: null, actorId: actor })

    expect((await rows()).map((r) => [r.key, r.value, r.updated_by])).toEqual([
      ["host_messaging_kill_switch", true, actor],
    ])
    expect(await audits()).toEqual([
      { actor_id: actor, target: "flag:announcement_text", meta: { from: null, to: "Hi" } },
      { actor_id: actor, target: "flag:announcement_text", meta: { from: "Hi", to: "Bye" } },
      {
        actor_id: actor,
        target: "flag:host_messaging_kill_switch",
        meta: { from: null, to: true },
      },
      { actor_id: actor, target: "flag:announcement_text", meta: { from: "Bye", to: null } },
    ])
  })

  it("loads every row with the operator's email, null when the account is gone", async () => {
    const actor = await operator("ops2@civfix.org")
    await repo.set({ key: "announcement_text", value: "Hi", actorId: actor })
    await h.sql`
      INSERT INTO runtime_flags (key, value, updated_by) VALUES ('old_flag', 'true'::jsonb, ${GONE_USER})
    `

    const loaded = await repo.loadAll()
    expect(loaded.map(({ updatedAt: _, ...rest }) => rest)).toEqual([
      {
        key: "announcement_text",
        value: "Hi",
        updatedBy: actor,
        updatedByEmail: "ops2@civfix.org",
      },
      { key: "old_flag", value: true, updatedBy: GONE_USER, updatedByEmail: null },
    ])
    expect(loaded.every((r) => r.updatedAt instanceof Date)).toBe(true)
  })
})
