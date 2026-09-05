import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { makeFakeSql, type FakeSqlControl } from "../helpers/fake-sql.js"
import { backfillServedKeys } from "../../src/db/backfill-served-key.js"
import { R2_PUT_TTL_SEC } from "../../src/adapters/storage.r2.js"
import type { Sql } from "../../src/db/client.js"

const SELECT_PAGE = /SELECT\s+id\s+FROM media_assets/
const UPDATE_PAGE = /UPDATE media_assets/
const REMAINING = /count\(\*\)::int AS n/

interface Row {
  id: string
}

function scripted(pages: Row[][], updated: Row[][], remaining: number): FakeSqlControl {
  let pageIdx = 0
  let updateIdx = 0
  return makeFakeSql([
    { match: REMAINING, rows: [{ n: remaining }] },
    { match: UPDATE_PAGE, rows: () => updated[updateIdx++] ?? [] },
    { match: SELECT_PAGE, rows: () => pages[pageIdx++] ?? [] },
  ])
}

function statementsMatching(fake: FakeSqlControl, re: RegExp): { sql: string; values: unknown[] }[] {
  return fake.statements.filter((s) => re.test(s.sql))
}

describe("backfillServedKeys", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("does nothing on an empty table: one SELECT, no UPDATE, zero adopted", async () => {
    const fake = scripted([[]], [], 0)

    const result = await backfillServedKeys(fake.sql as unknown as Sql)

    expect(result).toEqual({ adopted: 0, skippedInsidePutWindow: 0 })
    expect(statementsMatching(fake, SELECT_PAGE)).toHaveLength(1)
    expect(statementsMatching(fake, UPDATE_PAGE)).toHaveLength(0)
  })

  it("selects ONLY ready rows whose served_key is still NULL", async () => {
    const fake = scripted([[]], [], 0)

    await backfillServedKeys(fake.sql as unknown as Sql)

    const select = statementsMatching(fake, SELECT_PAGE)[0]!
    expect(select.sql).toMatch(/status = 'ready'/)
    expect(select.sql).toMatch(/served_key IS NULL/)
  })

  it("re-applies the full predicate on the UPDATE so an already-backfilled row is never rewritten", async () => {
    const fake = scripted([[{ id: "a" }], []], [[{ id: "a" }]], 0)

    await backfillServedKeys(fake.sql as unknown as Sql, { batchSize: 10 })

    const update = statementsMatching(fake, UPDATE_PAGE)[0]!
    expect(update.sql).toMatch(/SET served_key = r2_key/)
    expect(update.sql).toMatch(/status = 'ready'/)
    expect(update.sql).toMatch(/served_key IS NULL/)
    expect(update.sql).toMatch(/created_at < now\(\) - make_interval/)
    expect(update.values).toContain(R2_PUT_TTL_SEC)
  })

  it("bounds each page by the batch size and keyset-pages by id, never re-reading a page", async () => {
    const fake = scripted(
      [[{ id: "a" }, { id: "b" }], [{ id: "c" }], []],
      [[{ id: "a" }, { id: "b" }], [{ id: "c" }]],
      0,
    )

    const result = await backfillServedKeys(fake.sql as unknown as Sql, { batchSize: 2 })

    expect(result.adopted).toBe(3)
    const selects = statementsMatching(fake, SELECT_PAGE)
    expect(selects).toHaveLength(3)
    for (const s of selects) expect(s.values).toContain(2)
    expect(selects[0]!.sql).not.toMatch(/id > \?/)
    expect(selects[1]!.sql).toMatch(/id > \?/)
    expect(selects[1]!.values).toContain("b")
    expect(selects[2]!.values).toContain("c")
  })

  it("is idempotent: a second run over rows the first adopted reports zero adopted", async () => {
    const first = scripted([[{ id: "a" }], []], [[{ id: "a" }]], 0)
    const firstRun = await backfillServedKeys(first.sql as unknown as Sql, { batchSize: 10 })
    expect(firstRun.adopted).toBe(1)

    const second = scripted([[]], [], 0)
    const secondRun = await backfillServedKeys(second.sql as unknown as Sql, { batchSize: 10 })

    expect(secondRun).toEqual({ adopted: 0, skippedInsidePutWindow: 0 })
    expect(statementsMatching(second, UPDATE_PAGE)).toHaveLength(0)
  })

  it("counts rows the UPDATE deliberately skipped as still inside the presigned-PUT window", async () => {
    const fake = scripted([[{ id: "a" }, { id: "b" }], []], [[{ id: "a" }]], 1)

    const result = await backfillServedKeys(fake.sql as unknown as Sql, { batchSize: 10 })

    expect(result.adopted).toBe(1)
    expect(result.skippedInsidePutWindow).toBe(1)
  })

  it("advances past a page the UPDATE skipped entirely instead of looping on it forever", async () => {
    const fake = scripted([[{ id: "a" }], []], [[]], 1)

    const result = await backfillServedKeys(fake.sql as unknown as Sql, { batchSize: 1 })

    expect(result.adopted).toBe(0)
    const selects = statementsMatching(fake, SELECT_PAGE)
    expect(selects).toHaveLength(2)
    expect(selects[1]!.values).toContain("a")
  })
})
