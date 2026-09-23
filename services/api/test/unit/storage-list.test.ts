import { describe, expect, it } from "vitest"
import { FakeStorage } from "@civfix/shared/fakes"

/**
 * FakeStorage.list / getObject back the inbound sweep. The fake mirrors R2's keyset pagination (sorted
 * keys, last-key-as-cursor) so sweep tests are deterministic.
 */

const enc = new TextEncoder()

async function seed(s: FakeStorage, keys: string[]): Promise<void> {
  for (const k of keys) await s.put(k, enc.encode(k))
}

describe("FakeStorage.list", () => {
  it("lists keys under a prefix, sorted, excluding other prefixes", async () => {
    const s = new FakeStorage()
    await seed(s, ["p/c.eml", "p/a.eml", "p/b.eml", "other/x.eml"])
    const { keys, cursor } = await s.list("p/")
    expect(keys).toEqual(["p/a.eml", "p/b.eml", "p/c.eml"])
    expect(cursor).toBeUndefined()
  })

  it("paginates via the cursor", async () => {
    const s = new FakeStorage()
    await seed(s, ["p/a", "p/b", "p/c", "p/d"])
    const page1 = await s.list("p/", { limit: 2 })
    expect(page1.keys).toEqual(["p/a", "p/b"])
    expect(page1.cursor).toBe("p/b")

    const page2 = await s.list("p/", { cursor: page1.cursor, limit: 2 })
    expect(page2.keys).toEqual(["p/c", "p/d"])
    expect(page2.cursor).toBeUndefined()
  })

  it("returns an empty page for an unknown prefix", async () => {
    const s = new FakeStorage()
    await seed(s, ["a/1"])
    const { keys, cursor } = await s.list("zzz/")
    expect(keys).toEqual([])
    expect(cursor).toBeUndefined()
  })
})

describe("FakeStorage.getObject", () => {
  it("returns the stored bytes, or null when absent", async () => {
    const s = new FakeStorage()
    await s.put("k", enc.encode("hello"))
    expect(new TextDecoder().decode((await s.getObject("k"))!)).toBe("hello")
    expect(await s.getObject("missing")).toBeNull()
  })
})
