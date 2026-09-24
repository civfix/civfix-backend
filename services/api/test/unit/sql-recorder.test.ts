import { describe, expect, it } from "vitest"
import { makeSqlRecorder, stableValue } from "../helpers/sql-recorder.js"

describe("sql-recorder", () => {
  it("renders a tagged template with numbered placeholders and records its parameters", async () => {
    const rec = makeSqlRecorder()
    await rec.sql`
      SELECT id FROM users
      WHERE handle = ${"ana"} AND created_at > ${new Date("2026-01-02T03:04:05.000Z")}
    `
    expect(rec.transcript()).toBe(
      'SELECT id FROM users WHERE handle = $1 AND created_at > $2 -- ["ana","2026-01-02T03:04:05.000Z"]',
    )
  })

  it("inlines nested fragments and renumbers their parameters", async () => {
    const rec = makeSqlRecorder()
    const filter = rec.sql`AND status = ${"open"}`
    const order = rec.sql`ORDER BY created_at DESC, id DESC`
    await rec.sql`SELECT * FROM reports WHERE owner = ${"u1"} ${filter} ${order} LIMIT ${20}`
    expect(rec.queries).toHaveLength(1)
    expect(rec.queries[0]).toMatchObject({
      text: "SELECT * FROM reports WHERE owner = $1 AND status = $2 ORDER BY created_at DESC, id DESC LIMIT $3",
      params: ["u1", "open", 20],
    })
  })

  it("records an unawaited fragment nowhere", async () => {
    const rec = makeSqlRecorder()
    void rec.sql`SELECT 1`
    await Promise.resolve()
    expect(rec.entries).toHaveLength(0)
  })

  it("renders helper calls as markers with their arguments", async () => {
    const rec = makeSqlRecorder()
    await rec.sql`SELECT * FROM ${rec.sql("user_blocks")} WHERE blocked_id IN ${rec.sql(["a", "b"])}`
    await rec.sql`INSERT INTO t ${rec.sql({ a: 1, b: null }, "a", "b")}`
    expect(rec.transcript()).toBe(
      [
        'SELECT * FROM <helper ["user_blocks"]> WHERE blocked_id IN <helper [["a","b"]]> -- []',
        'INSERT INTO t <helper [{"a":1,"b":null},"a","b"]> -- []',
      ].join("\n"),
    )
  })

  it("keeps json/array parameters as bind parameters, tagged by kind", async () => {
    const rec = makeSqlRecorder()
    await rec.sql`UPDATE t SET doc = ${rec.sql.json({ k: 1 })}, tags = ${rec.sql.array(["x"])}`
    expect(rec.transcript()).toBe(
      'UPDATE t SET doc = $1, tags = $2 -- [{"<json>":{"k":1}},{"<array>":["x"]}]',
    )
  })

  it("marks statements run through the transaction handle and the transaction boundaries", async () => {
    const rec = makeSqlRecorder()
    const result = await rec.sql.begin(async (tx) => {
      await tx`UPDATE a SET n = n + 1 WHERE id = ${1}`
      await rec.sql`SELECT outer_handle_inside_tx`
      return "done"
    })
    expect(result).toBe("done")
    expect(rec.transcript()).toBe(
      [
        "BEGIN tx1",
        "[tx1] UPDATE a SET n = n + 1 WHERE id = $1 -- [1]",
        "SELECT outer_handle_inside_tx -- []",
        "COMMIT tx1",
      ].join("\n"),
    )
  })

  it("rolls back when the callback throws, and records savepoints and begin modes", async () => {
    const rec = makeSqlRecorder()
    const boom = new Error("boom")
    await expect(
      rec.sql.begin("isolation level serializable", async (tx) => {
        await tx.savepoint(async (sp) => {
          await sp`DELETE FROM b`
        })
        throw boom
      }),
    ).rejects.toBe(boom)
    expect(rec.transcript()).toBe(
      [
        "BEGIN tx1 isolation level serializable",
        "SAVEPOINT tx1.sp2",
        "[tx1.sp2] DELETE FROM b -- []",
        "RELEASE tx1.sp2",
        "ROLLBACK tx1",
      ].join("\n"),
    )
  })

  it("awaits an array returned from begin, as postgres.js does", async () => {
    const rec = makeSqlRecorder()
    await rec.sql.begin((tx) => [tx`INSERT INTO a VALUES (${1})`, tx`INSERT INTO b VALUES (${2})`])
    expect(rec.transcript().split("\n")).toEqual([
      "BEGIN tx1",
      "[tx1] INSERT INTO a VALUES ($1) -- [1]",
      "[tx1] INSERT INTO b VALUES ($1) -- [2]",
      "COMMIT tx1",
    ])
  })

  it("serves scripted responses: queued first, then matchers, else an empty result with a count", async () => {
    const rec = makeSqlRecorder()
    rec.on(/FROM users/, [{ id: "matched" }])
    rec.enqueue([{ id: "queued" }])
    const first = await rec.sql`SELECT id FROM users`
    const second = await rec.sql`SELECT id FROM users`
    const third = await rec.sql`UPDATE other SET x = 1`
    expect(first).toEqual([{ id: "queued" }])
    expect(second).toEqual([{ id: "matched" }])
    expect(third).toEqual([])
    expect(third.count).toBe(0)
    expect(third.command).toBe("UPDATE")
  })

  it("rejects with a scripted error so catch branches are reachable", async () => {
    const rec = makeSqlRecorder()
    const unique = Object.assign(new Error("duplicate key"), { code: "23505" })
    rec.enqueue(unique)
    await expect(rec.sql`INSERT INTO t VALUES (${1})`).rejects.toBe(unique)
    expect(rec.queries).toHaveLength(1)
  })

  it("executes a query once no matter how often it is awaited", async () => {
    const rec = makeSqlRecorder()
    const q = rec.sql`SELECT 1`
    await q
    await q
    expect(rec.queries).toHaveLength(1)
  })

  it("renders unsafe text verbatim, renumbering its own placeholders when nested", async () => {
    const rec = makeSqlRecorder()
    await rec.sql`SELECT * FROM t WHERE a = ${1} ORDER BY ${rec.sql.unsafe("name ASC")}`
    await rec.sql.unsafe("SELECT $1::int", [7])
    expect(rec.transcript().split("\n")).toEqual([
      "SELECT * FROM t WHERE a = $1 ORDER BY name ASC -- [1]",
      "UNSAFE SELECT $1::int -- [7]",
    ])
  })

  it("streams cursor batches and records the cursor", async () => {
    const rec = makeSqlRecorder()
    rec.enqueue([{ n: 1 }, { n: 2 }, { n: 3 }])
    const seen: unknown[][] = []
    for await (const batch of rec.sql`SELECT n FROM t`.cursor(2)) seen.push(batch)
    expect(seen).toEqual([[{ n: 1 }, { n: 2 }], [{ n: 3 }]])
    expect(rec.transcript()).toBe("CURSOR SELECT n FROM t -- []")
  })

  it("records reserved connections and their release", async () => {
    const rec = makeSqlRecorder()
    const reserved = await rec.sql.reserve()
    await reserved`SELECT pg_advisory_lock(${42})`
    reserved.release()
    expect(rec.transcript().split("\n")).toEqual([
      "RESERVE reserved1",
      "[reserved1] SELECT pg_advisory_lock($1) -- [42]",
      "RELEASE reserved1",
    ])
  })

  it("fails loudly on a postgres.js API it does not emulate", () => {
    const rec = makeSqlRecorder()
    expect(() => (rec.sql as unknown as { listen: unknown }).listen).toThrow(
      /unsupported postgres\.js API "sql\.listen"/,
    )
  })

  it("keeps undefined, bigint and bytes visible in parameter lists", () => {
    expect(stableValue([undefined, 10n, new Uint8Array(3), null])).toBe(
      '[undefined,"10n","<bytes 3>",null]',
    )
  })
})
