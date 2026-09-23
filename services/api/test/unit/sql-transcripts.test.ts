import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  makeSqlRecorder,
  stableValue,
  type ExecutedQuery,
  type Response,
} from "../helpers/sql-recorder.js"
import { cases } from "../sql-transcripts/cases.generated.js"

// Pins the exact SQL every repository method and SQL-taking helper sends, so a refactor that moves or
// reshapes query code can prove it is behavior-neutral: the snapshot must not change. Each case runs twice,
// once with every statement returning no rows and once with every distinct statement returning one row
// (then none, so keyset loops terminate), which drives both the not-found and the found branches.

const FIXED_NOW = new Date("2026-03-04T05:06:07.000Z")
const MAX_STATEMENTS = 200

const ids = vi.hoisted(() => ({ n: 0 }))

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>()
  return {
    ...actual,
    randomUUID: () => `00000000-0000-4000-8000-${String(++ids.n).padStart(12, "0")}`,
    randomBytes: (size: number) => Buffer.alloc(size, 7),
    randomInt: (minOrMax: number, max?: number) => (max === undefined ? 0 : minOrMax),
  }
})

const ROW_VALUE_RULES: [RegExp, () => unknown][] = [
  [/(_at|At|_on|_until|Until|_since|Since|date|Date)$/, () => new Date(FIXED_NOW)],
  [/^(count|total|n|cnt)$|(_count|Count|_total|Total)$/, () => 2],
  [/^(is|has|can|ok|exists|allowed)([_A-Z]|$)|(_enabled|Enabled)$/, () => true],
  [/^lat$|_lat$|latitude/i, () => 34.05],
  [/^lng$|_lng$|lon$|longitude/i, () => -118.24],
  [/(ids|Ids|tags|Tags|list|List|items|Items|urls|Urls|emails|Emails|keys|Keys)$/, () => []],
  [
    /(json|meta|data|payload|settings|answers|documents|contacts|Json|Meta|Data|Payload|Settings)$/,
    () => ({}),
  ],
]

function rowValue(column: string): unknown {
  for (const [pattern, value] of ROW_VALUE_RULES) if (pattern.test(column)) return value()
  return `${column}-row`
}

function universalRow(): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string" || key === "then" || key === "toJSON") return undefined
        return rowValue(key)
      },
    },
  )
}

function outcome(value: unknown): string {
  try {
    return stableValue(value)
  } catch {
    return "<unserializable>"
  }
}

async function transcriptFor(
  run: (sql: never) => Promise<unknown>,
  mode: "empty" | "row",
): Promise<string> {
  ids.n = 0
  const answered = new Set<string>()
  let executed = 0
  const rec = makeSqlRecorder({
    respond: (query: ExecutedQuery): Response => {
      if (++executed > MAX_STATEMENTS) return new Error(`more than ${MAX_STATEMENTS} statements`)
      if (mode === "empty" || answered.has(query.text)) return []
      answered.add(query.text)
      return [universalRow()]
    },
  })
  let result: string
  try {
    const value = await run(rec.sql as never)
    const fragment =
      value !== null && typeof value === "object" && "render" in value && "cursor" in value
    if (fragment) await rec.sql`${value as never}`
    result = fragment ? "=> fragment" : `=> ${outcome(value)}`
  } catch (err) {
    result = `=> throws ${err instanceof Error ? `${err.name}: ${err.message}` : outcome(err)}`
  }
  return `${rec.transcript()}\n${result}`
}

beforeEach(() => {
  vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] })
  vi.spyOn(Math, "random").mockReturnValue(0.5)
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(
    <T extends ArrayBufferView | null>(array: T): T => {
      if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(7)
      return array
    },
  )
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
    () =>
      `00000000-0000-4000-8000-${String(++ids.n).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`,
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("sql transcripts", () => {
  it("covers every generated case exactly once", () => {
    const keys = cases.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  for (const c of cases) {
    it(c.key, async () => {
      const empty = await transcriptFor(c.run, "empty")
      const row = await transcriptFor(c.run, "row")
      expect(`-- empty\n${empty}\n-- row\n${row}`).toMatchSnapshot()
    })
  }
})
