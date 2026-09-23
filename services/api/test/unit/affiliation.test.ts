import { describe, expect, it } from "vitest"
import type { PersonDTO } from "@civfix/shared"
import type { Sql } from "../../src/db/client.js"
import {
  attachAffiliations,
  loadPrimaryAffiliations,
  withAffiliation,
} from "../../src/services/affiliation.js"

const ANN = "11111111-1111-4111-8111-111111111111"
const BOB = "22222222-2222-4222-8222-222222222222"
const CAROL = "33333333-3333-4333-8333-333333333333"

interface Capture {
  text: string
  args: readonly unknown[]
}

interface FakeRow {
  user_id: string
  id: string
  slug: string
  name: string
  verified_status: string
  verified_kind: string | null
  logo_key: string | null
}

function fakeSql(rows: FakeRow[]): { sql: Sql; calls: Capture[]; fragments: Capture[] } {
  const calls: Capture[] = []
  const fragments: Capture[] = []
  const tag = (strings: TemplateStringsArray, ...args: unknown[]): Promise<FakeRow[]> => {
    const capture = { text: strings.join("?"), args }
    if (capture.text.includes("FROM organization_members")) calls.push(capture)
    else fragments.push(capture)
    return Promise.resolve(rows)
  }
  return { sql: tag as unknown as Sql, calls, fragments }
}

function person(id: string): PersonDTO {
  return {
    id,
    name: id,
    handle: null,
    avatar: null,
    followers: 0,
    following: 0,
    isFollowing: false,
  }
}

function row(over: Partial<FakeRow> & { user_id: string; id: string }): FakeRow {
  return {
    slug: "ballona-creek-trust",
    name: "Ballona Creek Trust",
    verified_status: "unverified",
    verified_kind: null,
    logo_key: null,
    ...over,
  }
}

describe("loadPrimaryAffiliations", () => {
  it("issues exactly ONE query for a whole batch and de-duplicates the ids", async () => {
    const { sql, calls } = fakeSql([])
    await loadPrimaryAffiliations(sql, undefined, [ANN, BOB, ANN, BOB, CAROL], null)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args[0]).toEqual([ANN, BOB, CAROL])
  })

  it("issues no query at all for an empty batch", async () => {
    const { sql, calls } = fakeSql([])
    const out = await loadPrimaryAffiliations(sql, undefined, [], null)
    expect(calls).toHaveLength(0)
    expect(out.size).toBe(0)
  })

  it("batches only the present ids when a row-derived batch carries holes", async () => {
    const { sql, calls } = fakeSql([])
    await loadPrimaryAffiliations(sql, undefined, [ANN, null, BOB, undefined, ANN, null], null)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args[0]).toEqual([ANN, BOB])
  })

  it("issues no query at all when every id in the batch is missing", async () => {
    const { sql, calls } = fakeSql([])
    const out = await loadPrimaryAffiliations(sql, undefined, [null, undefined, null], null)
    expect(calls).toHaveLength(0)
    expect(out.size).toBe(0)
  })

  it("resolves the pin first and the earliest membership second, in the SQL itself", async () => {
    const { sql, calls } = fakeSql([])
    await loadPrimaryAffiliations(sql, undefined, [ANN], null)
    const text = calls[0]!.text.replace(/\s+/g, " ")
    // DISTINCT ON + this ORDER BY is what makes the read one query instead of one per person.
    expect(text).toContain("SELECT DISTINCT ON (m.user_id)")
    const pinFirst = text.indexOf("COALESCE(o.id = u.primary_organization_id, false) DESC")
    const earliestSecond = text.indexOf("m.joined_at ASC")
    expect(pinFirst).toBeGreaterThan(-1)
    expect(earliestSecond).toBeGreaterThan(pinFirst)
  })

  it("never returns a suspended or deleted organization, or a tombstoned member", async () => {
    const { sql, calls } = fakeSql([])
    await loadPrimaryAffiliations(sql, undefined, [ANN], null)
    const text = calls[0]!.text.replace(/\s+/g, " ")
    expect(text).toContain("u.deleted_at IS NULL")
    expect(text).toContain("o.deleted_at IS NULL")
    expect(text).toContain("o.suspended_at IS NULL")
  })

  it("never lets a blocked pair see each other's affiliation", async () => {
    const { sql, calls, fragments } = fakeSql([])
    await loadPrimaryAffiliations(sql, undefined, [ANN], BOB)
    expect(calls[0]!.text.replace(/\s+/g, " ")).toContain("AND NOT")
    const guard = fragments.map((f) => f.text.replace(/\s+/g, " ")).join(" ")
    expect(guard).toContain("user_blocks")
    expect(fragments.some((f) => f.args.includes(BOB))).toBe(true)
  })

  it("asks for no block exclusion at all when there is no viewer", async () => {
    const { sql, fragments } = fakeSql([])
    await loadPrimaryAffiliations(sql, undefined, [ANN], null)
    const guard = fragments.map((f) => f.text.replace(/\s+/g, " ")).join(" ")
    expect(guard).toContain("FALSE")
    expect(guard).not.toContain("user_blocks")
  })

  it("projects the badge fields, including the org's own verification", async () => {
    const { sql } = fakeSql([
      row({
        user_id: ANN,
        id: "org-1",
        verified_status: "verified",
        verified_kind: "nonprofit",
      }),
    ])
    const out = await loadPrimaryAffiliations(sql, undefined, [ANN], null)
    expect(out.get(ANN)).toEqual({
      id: "org-1",
      slug: "ballona-creek-trust",
      name: "Ballona Creek Trust",
      logoUrl: null,
      verified: true,
      verifiedKind: "nonprofit",
    })
  })

  it("presigns each distinct logo key ONCE, however many people share the organization", async () => {
    const { sql } = fakeSql([
      row({ user_id: ANN, id: "org-1", logo_key: "uploads/2026/01/logo" }),
      row({ user_id: BOB, id: "org-1", logo_key: "uploads/2026/01/logo" }),
      row({ user_id: CAROL, id: "org-2", logo_key: null }),
    ])
    const presigned: string[] = []
    const out = await loadPrimaryAffiliations(
      sql,
      (key) => {
        presigned.push(key)
        return Promise.resolve(`https://cdn.example/${key}`)
      },
      [ANN, BOB, CAROL],
      null,
    )
    expect(presigned).toEqual(["uploads/2026/01/logo"])
    expect(out.get(ANN)?.logoUrl).toBe("https://cdn.example/uploads/2026/01/logo")
    expect(out.get(BOB)?.logoUrl).toBe("https://cdn.example/uploads/2026/01/logo")
    expect(out.get(CAROL)?.logoUrl).toBeNull()
  })

  it("leaves logoUrl null when no presigner is wired (offline / fake container)", async () => {
    const { sql } = fakeSql([row({ user_id: ANN, id: "org-1", logo_key: "uploads/x" })])
    const out = await loadPrimaryAffiliations(sql, undefined, [ANN], null)
    expect(out.get(ANN)?.logoUrl).toBeNull()
  })
})

describe("withAffiliation / attachAffiliations", () => {
  it("returns the person untouched when they belong to no organization", () => {
    const p = person(ANN)
    expect(withAffiliation(p, new Map())).toBe(p)
    expect(withAffiliation(p, new Map()).organization).toBeUndefined()
  })

  it("attaches the batch to every person that has one and leaves the rest alone", async () => {
    const { sql, calls } = fakeSql([row({ user_id: BOB, id: "org-1" })])
    const out = await attachAffiliations(
      (ids, viewerId) => loadPrimaryAffiliations(sql, undefined, ids, viewerId),
      [person(ANN), person(BOB)],
      null,
    )
    expect(calls).toHaveLength(1)
    expect(out[0]!.organization).toBeUndefined()
    expect(out[1]!.organization).toMatchObject({ id: "org-1" })
  })

  it("is a no-op with no loader wired, so a memory-repo caller stays offline", async () => {
    const people = [person(ANN)]
    expect(await attachAffiliations(undefined, people, null)).toBe(people)
  })
})
